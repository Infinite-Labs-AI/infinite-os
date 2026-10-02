// `ReportBuilder` (§3i, schema `infinite-tag.report.v2`): the before/after report the user ends with,
// the same in the terminal, on the PR and in the Infinite app.
//
// Three columns ("Live site today", "In this pull request", "Proven live") plus the single `day7` cell,
// rendered only as the "7 days later" row (no fourth column). The rules (§3i.3, §3i.7), enforced on
// EVERY cell the builder emits and on every snapshot it is handed:
// 1. `value:null` → `display:"—"` plus one reason; never 0.
// 2. `provenance.source` is one of PROVENANCE_SOURCES (no `agent` source exists).
// 3. "verified"/"proven" in a display only with `provenance.receiptAt` AND `provenance.runId === runId`.
// 4. A denominator below 50 page views shows raw counts ("3 of 41"), never a percentage.
// 5. No deltas or arrows across columns; each cell carries its own window.
// 7. `in_pr` cells are keyed to `columns.in_pr.sha` and rebuilt on each new head.
// A finish-line cell is computed ONLY from the inputs FINISH_LINE_SOURCES names for its column; a cell
// whose inputs are absent is `not_measured` ("—") and leaves N, the determinable count.
import {
  CELL_STATES,
  FINISH_LINE_IDS,
  FINISH_LINE_INPUTS,
  FINISH_LINE_INPUT_PROVENANCE,
  FINISH_LINE_SOURCES,
  NULL_DISPLAY,
  PROVENANCE_SOURCES,
  REASONS,
  REPORT_COLUMN_IDS,
  REPORT_ROWS,
  REPORT_SCHEMA,
  REPORT_V2_SHAPE,
  SAMPLE_FLOOR_PAGE_VIEWS,
  allowedFinishLineProvenance,
  type Cell,
  type CellState,
  type FinishLineId,
  type FinishLineInput,
  type ProvenanceSource,
  type Reason,
  type ReportBuilder,
  type ReportColumnId,
  type ReportColumnMeta,
  type ReportColumnSnapshot,
  type ReportRowId,
  type ReportV2
} from "./contracts/report.js"
import { FORBIDDEN_CHECKBOX } from "./contracts/git-host.js"
import { shapeErrors } from "./contracts/shape.js"

export const COLUMN_LABELS: Record<ReportColumnId, string> = {
  live_today: "Live site today",
  in_pr: "In this pull request",
  proven_live: "Proven live"
}

/** Plain-text words for each state (the report never uses a checkbox). */
export const STATE_WORDS: Record<CellState, string> = {
  pass: "pass",
  problem: "problem",
  undetermined: "unknown",
  info: "info",
  pending: "pending",
  not_measured: "not measured"
}

/** One footnote per reason a "—" (or a pending cell) carries. */
export const REASON_TEXT: Record<Reason, string> = {
  not_connected: "the tool is not connected in Infinite",
  needs_7_days: "measured again 7 days after the deploy",
  via_tag_manager: "the tag runs through a tag manager, which this run cannot read",
  read_failed: "Infinite could not read it this time",
  not_built: "this check is not available in this version",
  below_sample_floor: "fewer than 50 page views, so raw counts are shown",
  held_by_consent: "the tool waits for consent, so the test could not see it",
  preview_protected: "the preview is password-protected, so the rehearsal could not load it",
  env_dependent: "the ID comes from a setting that previews do not have",
  pending_deploy: "waiting for the deploy",
  pending_open_infinite: "open Infinite (or re-run npx infinite-tag) to finish the live checks",
  not_vercel: "the site is not on Vercel, so previews cannot be loaded",
  automation_detected: "the site treated the test window as a bot",
  not_exercised: "this run did not exercise it",
  not_probed: "the server lane was not probed"
}

export class ReportRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReportRuleError"
  }
}

// ---------------------------------------------------------------------------------------------
// Typed inputs
// ---------------------------------------------------------------------------------------------

/** One reading of a §3i.7 finish-line input (a graded test, a check, a cloud read, a receipt, a plan answer). */
export interface ColumnFact {
  input: FinishLineInput
  state: "pass" | "problem" | "undetermined" | "info" | "pending"
  /** Shown when this reading decides the cell; the state word otherwise. */
  display?: string
  at: string
  checkId?: string
  /** Required for any display that says "verified" or "proven" (receipt-backed readings). */
  receiptAt?: string
  window?: { from: string; to: string }
  reason?: Reason
}

/** One row cell, from a named source (never computed from agent output). */
export interface RowCellInput {
  value: string | number | null
  display?: string
  state: Exclude<CellState, "not_measured"> | "not_measured"
  source: ProvenanceSource
  at: string
  checkId?: string
  receiptAt?: string
  window?: { from: string; to: string }
  reason?: Reason
  /** A share: below the sample floor the display is raw counts. */
  raw?: { numerator: number; denominator: number }
}

export interface ColumnInput {
  runId: string
  meta: ReportColumnMeta
  facts: readonly ColumnFact[]
  /** `checks_passing` and `day7_checkin` are computed; any other row may be given. */
  rows: Partial<Record<Exclude<ReportRowId, "checks_passing" | "day7_checkin">, RowCellInput>>
  /**
   * How a finish-line cell with no reading reads (default: "—", `not_measured`, `not_exercised`). E.g. a
   * `prove` that lost the proof claim has no real-visit facts: those cells are pending `pending_open_infinite`.
   */
  unmeasured?: { reason: Reason; state: "pending" | "not_measured" }
}

// ---------------------------------------------------------------------------------------------
// Cell rules
// ---------------------------------------------------------------------------------------------

const PROVENANCE_SET: ReadonlySet<string> = new Set(PROVENANCE_SOURCES)
const REASON_SET: ReadonlySet<string> = new Set(REASONS)
const STATE_SET: ReadonlySet<string> = new Set(CELL_STATES)
const INPUT_SET: ReadonlySet<string> = new Set(FINISH_LINE_INPUTS)
const CLAIM_WORDS = /\b(verified|proven)\b/i

/** Every §3i.3 rule one cell breaks (an empty list = the cell is honest). */
export function cellViolations(where: string, cell: Cell, runId: string): string[] {
  const out: string[] = []
  if (!PROVENANCE_SET.has(cell.provenance?.source as string)) {
    out.push(`${where}: provenance source ${JSON.stringify(cell.provenance?.source)} is not allowed (no cell comes from agent output)`)
  }
  if (cell.provenance?.runId !== runId) out.push(`${where}: provenance is from run ${JSON.stringify(cell.provenance?.runId)}, not this run`)
  if (!STATE_SET.has(cell.state)) out.push(`${where}: state ${JSON.stringify(cell.state)} is not a cell state`)
  if (cell.reason !== undefined && !REASON_SET.has(cell.reason)) out.push(`${where}: reason ${JSON.stringify(cell.reason)} is not a report reason`)
  if (cell.value === null) {
    if (cell.display !== NULL_DISPLAY) out.push(`${where}: an unmeasured value must show "${NULL_DISPLAY}", not ${JSON.stringify(cell.display)}`)
    if (cell.reason === undefined) out.push(`${where}: a "${NULL_DISPLAY}" needs one reason`)
  } else if (cell.display === NULL_DISPLAY && cell.reason === undefined) {
    out.push(`${where}: "${NULL_DISPLAY}" needs one reason`)
  }
  if (cell.state === "not_measured" && cell.value !== null) out.push(`${where}: not_measured must carry value null`)
  if (CLAIM_WORDS.test(cell.display) && (!cell.provenance?.receiptAt || cell.provenance.runId !== runId)) {
    out.push(`${where}: says "verified"/"proven" without a receipt from this run`)
  }
  if (cell.raw) {
    if (!(cell.raw.denominator >= 0) || !(cell.raw.numerator >= 0)) out.push(`${where}: raw counts must be non-negative`)
    if (cell.raw.denominator < SAMPLE_FLOOR_PAGE_VIEWS && /%/.test(cell.display)) {
      out.push(`${where}: a percentage below the ${SAMPLE_FLOOR_PAGE_VIEWS}-page-view floor (show raw counts)`)
    }
  }
  if (/[→←↑↓]|\bvs\.? (?:before|last)\b/.test(cell.display)) out.push(`${where}: no deltas or arrows across columns`)
  if (cell.display.includes(FORBIDDEN_CHECKBOX)) out.push(`${where}: a checkbox in a cell`)
  return out
}

function assertCell(where: string, cell: Cell, runId: string): Cell {
  const problems = cellViolations(where, cell, runId)
  if (problems.length > 0) throw new ReportRuleError(problems.join("; "))
  return cell
}

/** "3 of 41" below the floor, "7%" at or above it. */
export function formatShare(numerator: number, denominator: number): string {
  if (denominator < SAMPLE_FLOOR_PAGE_VIEWS) return `${numerator} of ${denominator}`
  if (denominator === 0) return `${numerator} of 0`
  return `${Math.round((numerator / denominator) * 100)}%`
}

function dashCell(source: ProvenanceSource, at: string, runId: string, reason: Reason, state: "not_measured" | "pending" = "not_measured"): Cell {
  return { value: null, display: NULL_DISPLAY, state, provenance: { source, at, runId }, reason }
}

function rowCell(where: string, input: RowCellInput, runId: string): Cell {
  let display = input.display
  if (input.value === null) display = NULL_DISPLAY
  else if (input.raw && display === undefined) display = formatShare(input.raw.numerator, input.raw.denominator)
  else if (display === undefined) display = String(input.value)
  const provenance: Cell["provenance"] = {
    source: input.source,
    at: input.at,
    runId,
    ...(input.checkId ? { checkId: input.checkId } : {}),
    ...(input.window ? { window: input.window } : {}),
    ...(input.receiptAt ? { receiptAt: input.receiptAt } : {})
  }
  const reason = input.reason ?? (input.raw && input.raw.denominator < SAMPLE_FLOOR_PAGE_VIEWS ? "below_sample_floor" : undefined)
  const cell: Cell = {
    value: input.value,
    display,
    state: input.value === null && input.state === "pass" ? "not_measured" : input.state,
    provenance,
    ...(reason ? { reason } : {}),
    ...(input.raw ? { raw: input.raw } : {})
  }
  return assertCell(where, cell, runId)
}

const STATE_SEVERITY: Record<ColumnFact["state"], number> = { problem: 4, undetermined: 3, pending: 2, pass: 1, info: 0 }

function finishLineCell(
  id: FinishLineId,
  column: ReportColumnId,
  facts: readonly ColumnFact[],
  runId: string,
  fallbackAt: string,
  unmeasured: ColumnInput["unmeasured"] = undefined
): Cell {
  const spec = FINISH_LINE_SOURCES[id][column]
  const where = `finishLine.${id}.${column}`
  if (spec.notMeasured) return dashCell("wizard_check", fallbackAt, runId, spec.notMeasured)
  const readings = facts.filter((fact) => spec.inputs.includes(fact.input))
  if (readings.length === 0) {
    // A pending-by-design cell (it waits for a real event or day 7) is pending even before its input exists.
    if (spec.fixedState === "pending") {
      const source = FINISH_LINE_INPUT_PROVENANCE[spec.inputs[0]!]
      return dashCell(source, fallbackAt, runId, spec.reason ?? "not_exercised", "pending")
    }
    return dashCell(dashSource(id, column), fallbackAt, runId, unmeasured?.reason ?? "not_exercised", unmeasured?.state ?? "not_measured")
  }
  // The worst reading decides; its input names the provenance.
  const decider = [...readings].sort((a, b) => STATE_SEVERITY[b.state] - STATE_SEVERITY[a.state] || b.at.localeCompare(a.at))[0]!
  let state: CellState = readings.every((fact) => fact.state === "info") ? "info" : decider.state
  if (spec.fixedState === "info") state = "info"
  if (spec.fixedState === "pending" && state !== "pass" && state !== "problem") state = "pending"
  const source = FINISH_LINE_INPUT_PROVENANCE[decider.input]
  const reason = decider.reason ?? (state === "pending" ? spec.reason : undefined)
  const cell: Cell = {
    value: STATE_WORDS[state],
    display: decider.display ?? STATE_WORDS[state],
    state,
    provenance: {
      source,
      at: readings.map((fact) => fact.at).sort().at(-1)!,
      runId,
      ...(decider.checkId ? { checkId: decider.checkId } : {}),
      ...(decider.window ? { window: decider.window } : {}),
      ...(decider.receiptAt ? { receiptAt: decider.receiptAt } : {})
    },
    ...(reason ? { reason } : {})
  }
  return assertCell(where, cell, runId)
}

/**
 * The provenance a "—" finish-line cell carries: the first source §3i.7 allows for it (the parser checks the
 * source of every finish-line cell that §3i.7 does not mark "not measured", "—" included).
 */
function dashSource(id: FinishLineId, column: ReportColumnId): ProvenanceSource {
  return allowedFinishLineProvenance(id, column)[0] ?? "wizard_check"
}

function assertFinishLineSource(id: FinishLineId, column: ReportColumnId, cell: Cell): void {
  const spec = FINISH_LINE_SOURCES[id][column]
  if (spec.notMeasured) {
    if (cell.state !== "not_measured") throw new ReportRuleError(`finishLine.${id}.${column}: §3i.7 says this cell is not measured (${spec.notMeasured})`)
    return
  }
  if (!allowedFinishLineProvenance(id, column).includes(cell.provenance.source)) {
    throw new ReportRuleError(`finishLine.${id}.${column}: source ${cell.provenance.source} is not one §3i.7 allows`)
  }
}

// ---------------------------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------------------------

/** "X pass · Y problems · Z unknown of N determinable" from one column's finish-line cells. */
export function checksPassingCell(finishLine: Partial<Record<FinishLineId, Cell>>, runId: string, at: string): Cell {
  let pass = 0
  let problems = 0
  let unknown = 0
  let pending = 0
  for (const id of FINISH_LINE_IDS) {
    const cell = finishLine[id]
    if (!cell) continue
    if (cell.state === "pass") pass += 1
    else if (cell.state === "problem") problems += 1
    else if (cell.state === "undetermined") unknown += 1
    else if (cell.state === "pending") {
      unknown += 1
      pending += 1
    }
  }
  const determinable = pass + problems + unknown
  if (determinable === 0) return dashCell("wizard_check", at, runId, "not_exercised")
  const state: CellState = problems > 0 ? "problem" : unknown > 0 ? (pending === unknown ? "pending" : "undetermined") : "pass"
  return assertCell("rows.checks_passing", {
    value: `${pass}/${determinable}`,
    display: `${pass} pass · ${problems} problem${problems === 1 ? "" : "s"} · ${unknown} unknown of ${determinable} determinable`,
    state,
    provenance: { source: "wizard_check", at, runId }
  }, runId)
}

/** Builds one column from typed inputs (lanes O8, O4 and O1's `prove` call this for their column). */
export function buildColumn(column: ReportColumnId, input: ColumnInput): ReportColumnSnapshot {
  for (const fact of input.facts) {
    if (!INPUT_SET.has(fact.input)) throw new ReportRuleError(`${column}: ${JSON.stringify(fact.input)} is not a finish-line input`)
    if (!(fact.state in STATE_SEVERITY)) throw new ReportRuleError(`${column}: fact state ${JSON.stringify(fact.state)}`)
    if (fact.display !== undefined && CLAIM_WORDS.test(fact.display) && !fact.receiptAt) {
      throw new ReportRuleError(`${column}: the ${fact.input} reading says "verified"/"proven" without a receipt`)
    }
  }
  if (column === "in_pr" && !input.meta.sha) throw new ReportRuleError("in_pr: the column is keyed to the PR head (meta.sha is required)")
  const at = input.meta.measuredAt ?? input.facts.map((fact) => fact.at).sort().at(-1) ?? new Date(0).toISOString()
  const finishLine: Partial<Record<FinishLineId, Cell>> = {}
  for (const id of FINISH_LINE_IDS) finishLine[id] = finishLineCell(id, column, input.facts, input.runId, at, input.unmeasured)
  const cells: Partial<Record<ReportRowId, Cell>> = {}
  for (const [rowId, rowInput] of Object.entries(input.rows) as Array<[ReportRowId, RowCellInput | undefined]>) {
    if (!rowInput) continue
    if (rowId === "checks_passing" || rowId === "day7_checkin") throw new ReportRuleError(`${column}: the ${rowId} row is computed, never given`)
    cells[rowId] = rowCell(`rows.${rowId}.${column}`, rowInput, input.runId)
  }
  cells.checks_passing = checksPassingCell(finishLine, input.runId, at)
  return { meta: { ...input.meta }, cells, finishLine }
}

/**
 * Recomputes ONE finish-line cell of a built column from new readings (e.g. `done` learns the run's
 * check-in date after its PATCH) and re-derives `checks_passing`. Same rules as `buildColumn`.
 */
export function withFinishLineReadings(
  column: ReportColumnId,
  snapshot: ReportColumnSnapshot,
  id: FinishLineId,
  facts: readonly ColumnFact[],
  runId: string
): ReportColumnSnapshot {
  for (const fact of facts) {
    if (!INPUT_SET.has(fact.input)) throw new ReportRuleError(`${column}: ${JSON.stringify(fact.input)} is not a finish-line input`)
  }
  const at = facts.map((fact) => fact.at).sort().at(-1) ?? snapshot.meta.measuredAt ?? new Date(0).toISOString()
  const finishLine = { ...snapshot.finishLine, [id]: finishLineCell(id, column, facts, runId, at) }
  return {
    meta: { ...snapshot.meta },
    cells: { ...snapshot.cells, checks_passing: checksPassingCell(finishLine, runId, snapshot.meta.measuredAt ?? at) },
    finishLine
  }
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

type BuildInput = Parameters<ReportBuilder["build"]>[0]

function missingColumnReason(column: ReportColumnId, pending: ReportV2["columns"]["proven_live"]["pending"]): { reason: Reason; state: "pending" | "not_measured" } {
  if (column !== "proven_live") return { reason: "not_exercised", state: "not_measured" }
  if (pending === "deploy") return { reason: "pending_deploy", state: "pending" }
  if (pending === "open_infinite" || pending === "rerun_tag") return { reason: "pending_open_infinite", state: "pending" }
  return { reason: "not_exercised", state: "not_measured" }
}

function validateSnapshotCells(column: ReportColumnId, snapshot: ReportColumnSnapshot, runId: string): void {
  for (const [rowId, cell] of Object.entries(snapshot.cells)) {
    if (cell) assertCell(`rows.${rowId}.${column}`, cell, runId)
  }
  for (const [id, cell] of Object.entries(snapshot.finishLine) as Array<[FinishLineId, Cell | undefined]>) {
    if (!cell) continue
    assertCell(`finishLine.${id}.${column}`, cell, runId)
    assertFinishLineSource(id, column, cell)
  }
}

export function buildReport(input: BuildInput, now: () => Date = () => new Date()): ReportV2 {
  const { runId } = input
  const generatedAt = now().toISOString()
  const pending = input.provenLivePending
  const columnsMeta = {
    live_today: input.columns.live_today?.meta ?? { measuredAt: null, sha: null },
    in_pr: input.columns.in_pr?.meta ?? { measuredAt: null, sha: null },
    proven_live: { ...(input.columns.proven_live?.meta ?? { measuredAt: null, sha: null }), pending }
  }
  for (const column of REPORT_COLUMN_IDS) {
    const snapshot = input.columns[column]
    if (snapshot) validateSnapshotCells(column, snapshot, runId)
  }
  const cellFor = (column: ReportColumnId, get: (snapshot: ReportColumnSnapshot) => Cell | undefined, fallback: () => Cell): Cell => {
    const snapshot = input.columns[column]
    return (snapshot && get(snapshot)) || fallback()
  }
  const missing = (column: ReportColumnId): Cell => {
    const why = missingColumnReason(column, pending)
    return dashCell("wizard_check", generatedAt, runId, why.reason, why.state)
  }

  const day7Cell = input.day7?.cell ?? null
  if (day7Cell) assertCell("day7.cell", day7Cell, runId)

  const rows: ReportV2["rows"] = REPORT_ROWS.map((row) => {
    const cells = {} as Record<ReportColumnId, Cell>
    for (const column of REPORT_COLUMN_IDS) {
      if (row.id === "day7_checkin") {
        cells[column] = column === "proven_live" && day7Cell ? day7Cell : dashCell("cloud_read", generatedAt, runId, "needs_7_days")
        continue
      }
      cells[column] = cellFor(column, (snapshot) => snapshot.cells[row.id], () => missing(column))
    }
    return { id: row.id, label: row.label, cells }
  })

  const finishLine: ReportV2["finishLine"] = FINISH_LINE_IDS.map((id, index) => {
    const cells = {} as Record<ReportColumnId, Cell>
    for (const column of REPORT_COLUMN_IDS) {
      const spec = FINISH_LINE_SOURCES[id][column]
      cells[column] = spec.notMeasured
        ? dashCell("wizard_check", generatedAt, runId, spec.notMeasured)
        : cellFor(column, (snapshot) => snapshot.finishLine[id], () => ({ ...missing(column), provenance: { source: dashSource(id, column), at: generatedAt, runId } }))
    }
    return { n: index + 1, id, cells }
  })

  const report: ReportV2 = {
    schema: REPORT_SCHEMA,
    runId,
    tagVersion: input.tagVersion,
    generatedAt,
    site: { ...input.site },
    columns: columnsMeta,
    rows,
    day7: input.day7 ?? { measuredAt: null, window: null, cell: null },
    finishLine,
    notes: [...input.notes]
  }
  assertReport(report)
  return report
}

/** Every rule the whole report must satisfy; throws the first set of problems found. */
export function assertReport(report: ReportV2): void {
  const problems = shapeErrors(report, REPORT_V2_SHAPE)
  if (report.schema !== REPORT_SCHEMA) problems.push(`schema is ${JSON.stringify(report.schema)}`)
  if (report.rows.map((row) => row.id).join() !== REPORT_ROWS.map((row) => row.id).join()) problems.push("rows are not the §3i.4 rows in order")
  if (report.finishLine.map((line) => line.id).join() !== FINISH_LINE_IDS.join()) problems.push("finishLine is not the 14 ids in order")
  if (problems.length > 0) throw new ReportRuleError(problems.join("; "))
  for (const row of report.rows) for (const column of REPORT_COLUMN_IDS) assertCell(`rows.${row.id}.${column}`, row.cells[column], report.runId)
  for (const line of report.finishLine) {
    for (const column of REPORT_COLUMN_IDS) {
      assertCell(`finishLine.${line.id}.${column}`, line.cells[column], report.runId)
      assertFinishLineSource(line.id, column, line.cells[column])
    }
  }
  if (report.day7.cell) assertCell("day7.cell", report.day7.cell, report.runId)
}

// ---------------------------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------------------------

function footnotes(report: ReportV2): string[] {
  const reasons = new Set<Reason>()
  const visit = (cell: Cell) => {
    if (cell.reason && (cell.value === null || cell.state === "pending" || cell.reason === "below_sample_floor")) reasons.add(cell.reason)
  }
  for (const row of report.rows) for (const column of REPORT_COLUMN_IDS) visit(row.cells[column])
  return REASONS.filter((reason) => reasons.has(reason)).map((reason) => `${NULL_DISPLAY} / pending: ${REASON_TEXT[reason]}`)
}

function cellText(cell: Cell): string {
  if (cell.value === null) return NULL_DISPLAY
  if (cell.state === "pass" || cell.state === "info" || cell.display === STATE_WORDS[cell.state]) return cell.display
  return `${cell.display} (${STATE_WORDS[cell.state]})`
}

function day7Text(report: ReportV2): string {
  const cell = report.day7.cell
  return cell ? cellText(cell) : `${NULL_DISPLAY} (${REASON_TEXT.needs_7_days})`
}

function fit(text: string, width: number): string {
  if (width <= 1) return text.slice(0, Math.max(0, width))
  if (text.length <= width) return text.padEnd(width)
  return `${text.slice(0, width - 1)}…`
}

/** The terminal table. Below 100 columns each row is stacked (label, then one line per column). */
export function renderTerminal(report: ReportV2, width: number): string {
  const lines: string[] = []
  const tableRows = report.rows.filter((row) => row.id !== "day7_checkin")
  const site = report.site.productionHost ?? report.site.repoLabel
  lines.push(`Before and after · ${site} · run ${report.runId.slice(0, 8)}`)
  if (width >= 100) {
    const labelWidth = 26
    const columnWidth = Math.max(16, Math.floor((width - labelWidth - 6) / 3))
    lines.push([fit("", labelWidth), ...REPORT_COLUMN_IDS.map((column) => fit(COLUMN_LABELS[column], columnWidth))].join("  ").trimEnd())
    for (const row of tableRows) {
      lines.push([fit(row.label, labelWidth), ...REPORT_COLUMN_IDS.map((column) => fit(cellText(row.cells[column]), columnWidth))].join("  ").trimEnd())
    }
  } else {
    const inner = Math.max(10, width - 4)
    for (const row of tableRows) {
      lines.push(fit(row.label, width).trimEnd())
      for (const column of REPORT_COLUMN_IDS) {
        lines.push(`  ${fit(`${COLUMN_LABELS[column]}: ${cellText(row.cells[column])}`, inner)}`.trimEnd())
      }
    }
  }
  lines.push(fit(`7 days later: ${day7Text(report)}`, width).trimEnd())
  for (const note of [...report.notes, ...footnotes(report)]) lines.push(fit(note, width).trimEnd())
  return lines.join("\n")
}

function md(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/** The PR / app markdown: plain-text statuses, never a `- [ ]`. */
export function renderMarkdown(report: ReportV2): string {
  const out: string[] = []
  const site = report.site.productionHost ?? report.site.repoLabel
  out.push(`### Before and after · ${md(site)}`)
  out.push("")
  out.push(`| | ${REPORT_COLUMN_IDS.map((column) => COLUMN_LABELS[column]).join(" | ")} |`)
  out.push(`|---|${REPORT_COLUMN_IDS.map(() => "---").join("|")}|`)
  for (const row of report.rows) {
    if (row.id === "day7_checkin") continue
    out.push(`| ${md(row.label)} | ${REPORT_COLUMN_IDS.map((column) => md(cellText(row.cells[column]))).join(" | ")} |`)
  }
  out.push("")
  out.push(`**7 days later:** ${md(day7Text(report))}`)
  out.push("")
  out.push("<details><summary>The 14 checks</summary>")
  out.push("")
  out.push(`| # | Check | ${REPORT_COLUMN_IDS.map((column) => COLUMN_LABELS[column]).join(" | ")} |`)
  out.push(`|---|---|${REPORT_COLUMN_IDS.map(() => "---").join("|")}|`)
  for (const line of report.finishLine) {
    out.push(`| ${line.n} | ${line.id.replace(/_/g, " ")} | ${REPORT_COLUMN_IDS.map((column) => md(cellText(line.cells[column]))).join(" | ")} |`)
  }
  out.push("")
  out.push("</details>")
  const notes = [...report.notes, ...footnotes(report)]
  if (notes.length > 0) {
    out.push("")
    for (const note of notes) out.push(`${md(note)}  `)
  }
  const text = out.join("\n")
  if (text.includes(FORBIDDEN_CHECKBOX)) throw new ReportRuleError("the markdown would contain a checkbox")
  return text
}

/** The JSON the cloud stores: re-validated and copied. */
export function reportPayload(report: ReportV2): ReportV2 {
  assertReport(report)
  return structuredClone(report)
}

export function createReportBuilder(now: () => Date = () => new Date()): ReportBuilder {
  return {
    build: (input) => buildReport(input, now),
    renderTerminal,
    renderMarkdown,
    payload: reportPayload
  }
}
