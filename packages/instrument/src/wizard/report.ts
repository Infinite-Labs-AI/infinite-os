import { createScanner } from "../review/scan.js"
import { quoteDisplayNote } from "../review/display.js"
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
import type { OwnerBoundaryMeasurement } from "../jobs/owner-diff.js"
import type { ChecklistItem } from "./contracts/jobs.js"
import { consentActivationFromNotes, consentActivationNotes, consentHandoff, CONSENT_WAITING } from "../install/consent-handoff.js"
import { OWNER_BOUNDARY, OWNER_BOUNDARY_UNMEASURED, LEGACY_OWNER_BOUNDARY, hasRecordedPolicyEdits, withOwnerBoundary, ownerBoundaryNotes, isOwnerBoundaryStatement, hasLegacyOwnerHistory } from "../jobs/owner-boundary.js"
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
  type VerdictReasonKind,
  type ReportV2
} from "./contracts/report.js"
import { FORBIDDEN_CHECKBOX } from "./contracts/git-host.js"
import { computeVerdict, verdictErrors } from "./verdict.js"
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
  below_sample_floor: "below 50 page views: raw counts shown",
  held_by_consent: "the tool waits for consent, so the test could not see it",
  preview_protected: "the preview is password-protected, so the rehearsal could not load it",
  env_dependent: "the ID comes from a setting that previews do not have",
  pending_deploy: "waiting for the deploy",
  pending_open_infinite: "open Infinite (or re-run npx infinite-tag) to finish the live checks",
  not_vercel: "no Vercel preview was found for this site, so previews cannot be loaded",
  automation_detected: "the site treated the test window as a bot",
  not_exercised: "this run did not exercise it",
  not_probed: "the server lane was not probed",
  waiting_real_event: "waiting for a real visitor's event after the deploy",
  blocked_by_site_bot_rules: "the site's bot rules refused the test window",
  test_error: "the test could not finish (it crashed or ran out of time)"
}

/** §3i.1: `columns.live_today.sha` is always null (the cloud's parser refuses any other value). */
export const LIVE_TODAY_SHA_RULE = "columns.live_today.sha must be null: the live site today has no commit SHA (§3i.1)"

export class ReportRuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReportRuleError"
  }
}

// Existing cloud wire limits. Full owner snippets stay in the trusted local render context.
const REPORT_NOTE_MAX_CHARS = 300
const REPORT_NOTE_LIMIT = 20
function boundedNotes(notes: readonly string[]): string[] {
  const summaries = [...new Set(notes.map(note => note.replace(/\s+/g, " ").trim()).filter(Boolean).map(note => note.length > REPORT_NOTE_MAX_CHARS ? `${note.slice(0, REPORT_NOTE_MAX_CHARS - 1)}…` : note))]
  if (summaries.length <= REPORT_NOTE_LIMIT) return summaries
  const boundary = summaries.filter(isOwnerBoundaryStatement)
  const other = summaries.filter(note => !isOwnerBoundaryStatement(note))
  const kept = other.slice(0, REPORT_NOTE_LIMIT - boundary.length - 1)
  return [...kept, `${other.length - kept.length} additional notes are omitted from this compact report; see the local checklist and review ledger.`, ...boundary]
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
  /** The run's server-clock start (`runs.start`): a receipt before it never backs "verified"/"proven". */
  runStartedAt?: string | null
  /** When the column's cells were built, for a column with no measurement (`meta.measuredAt` null, no fact). */
  builtAt?: string
}

// ---------------------------------------------------------------------------------------------
// Cell rules
// ---------------------------------------------------------------------------------------------

const PROVENANCE_SET: ReadonlySet<string> = new Set(PROVENANCE_SOURCES)
const REASON_SET: ReadonlySet<string> = new Set(REASONS)
const STATE_SET: ReadonlySet<string> = new Set(CELL_STATES)
const INPUT_SET: ReadonlySet<string> = new Set(FINISH_LINE_INPUTS)
const CLAIM_WORDS = /\b(verified|proven)\b/i
/**
 * §3z.8 rule 5, exactly as the cloud parser (1bu-1 `report-v2.ts` ARROWS) reads it: the arrow blocks
 * (U+2190–21FF, dingbats U+2794–27BF, supplemental A/B U+27F0–27FF and U+2900–297F, misc arrows
 * U+2B00–2BFF), the triangles, and the ASCII spellings `->`, `<-`, `=>`. A cell the cloud would refuse is
 * refused here first, so a report is never posted only to be rejected (review I1 P2-2).
 */
export const CELL_ARROWS = /[\u2190-\u21ff\u2794-\u27bf\u27f0-\u27ff\u2900-\u297f\u2b00-\u2bff▲△▼▽►▶◀◄]|->|<-|=>/
/** The cloud parser's string limits for a cell (§3z.8). */
export const CELL_LIMITS = { display: 200, value: 120, checkId: 80 } as const
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/
const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/
/** Reasons that say nothing was read: such a cell never carries a number (cloud rule 1). */
const NOTHING_READ_REASONS: ReadonlySet<string> = new Set(["read_failed", "not_connected"])

/**
 * Every §3i.3 / §3z.8 rule one cell breaks (an empty list = the cell is honest), the cloud parser's rules
 * included. `runStartedAt` (the run's server-clock start, from `runs.start`): a "verified"/"proven" receipt
 * from before it is never this run's proof; unknown (an older state file) → that one rule is not checked.
 */
export function cellViolations(where: string, cell: Cell, runId: string, runStartedAt: string | null = null): string[] {
  const out: string[] = []
  if (!PROVENANCE_SET.has(cell.provenance?.source as string)) {
    out.push(`${where}: provenance source ${JSON.stringify(cell.provenance?.source)} is not allowed (no cell comes from agent output)`)
  }
  if (cell.provenance?.runId !== runId) out.push(`${where}: provenance is from run ${JSON.stringify(cell.provenance?.runId)}, not this run`)
  if (!STATE_SET.has(cell.state)) out.push(`${where}: state ${JSON.stringify(cell.state)} is not a cell state`)
  if (cell.reason !== undefined && !REASON_SET.has(cell.reason)) out.push(`${where}: reason ${JSON.stringify(cell.reason)} is not a report reason`)
  if (typeof cell.display !== "string" || cell.display.length < 1 || cell.display.length > CELL_LIMITS.display) {
    out.push(`${where}: a display is 1–${CELL_LIMITS.display} characters`)
  } else if (CONTROL_CHARS.test(cell.display)) {
    out.push(`${where}: a display has no control characters`)
  }
  if (typeof cell.value === "string" && (cell.value.length > CELL_LIMITS.value || CONTROL_CHARS.test(cell.value))) {
    out.push(`${where}: a value is at most ${CELL_LIMITS.value} plain characters`)
  }
  if (typeof cell.value === "number" && !Number.isFinite(cell.value)) out.push(`${where}: a number must be finite`)
  if (cell.value === null) {
    if (cell.display !== NULL_DISPLAY) out.push(`${where}: an unmeasured value must show "${NULL_DISPLAY}", not ${JSON.stringify(cell.display)}`)
    if (cell.reason === undefined) out.push(`${where}: a "${NULL_DISPLAY}" needs one reason`)
    if (cell.state === "pass" || cell.state === "problem") out.push(`${where}: an unmeasured ("${NULL_DISPLAY}") cell is never a ${cell.state}`)
  } else {
    if (cell.display === NULL_DISPLAY) out.push(`${where}: a "${NULL_DISPLAY}" display must carry a null value`)
    if (typeof cell.value === "number" && cell.reason !== undefined && NOTHING_READ_REASONS.has(cell.reason)) {
      out.push(`${where}: a cell whose reason is ${cell.reason} read nothing, so it carries no number`)
    }
  }
  if (cell.state === "not_measured" && cell.value !== null) out.push(`${where}: not_measured must carry value null`)
  const checkId = cell.provenance?.checkId
  if (checkId !== undefined && (checkId.length > CELL_LIMITS.checkId || !CHECK_ID_PATTERN.test(checkId))) out.push(`${where}: ${JSON.stringify(checkId)} is not a check id`)
  if (typeof cell.display === "string" && CLAIM_WORDS.test(cell.display)) {
    if (!cell.provenance?.receiptAt || cell.provenance.runId !== runId) {
      out.push(`${where}: says "verified"/"proven" without a receipt from this run`)
    } else if (runStartedAt !== null && Date.parse(cell.provenance.receiptAt) < Date.parse(runStartedAt)) {
      out.push(`${where}: says "verified"/"proven" with a receipt from before this run started`)
    }
  }
  if (cell.raw) {
    if (!(cell.raw.denominator >= 0) || !(cell.raw.numerator >= 0)) out.push(`${where}: raw counts must be non-negative`)
    if (cell.raw.denominator < SAMPLE_FLOOR_PAGE_VIEWS && /%/.test(cell.display)) {
      out.push(`${where}: a percentage below the ${SAMPLE_FLOOR_PAGE_VIEWS}-page-view floor (show raw counts)`)
    }
  } else if (typeof cell.display === "string" && cell.display.includes("%")) {
    out.push(`${where}: a percentage needs its raw counts`)
  }
  if (typeof cell.display === "string" && (CELL_ARROWS.test(cell.display) || /\bvs\.? (?:before|last)\b/.test(cell.display))) out.push(`${where}: no deltas or arrows across columns`)
  if (typeof cell.display === "string" && cell.display.includes(FORBIDDEN_CHECKBOX)) out.push(`${where}: a checkbox in a cell`)
  return out
}

function assertCell(where: string, cell: Cell, runId: string, runStartedAt: string | null = null): Cell {
  const problems = cellViolations(where, cell, runId, runStartedAt)
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

function rowCell(where: string, input: RowCellInput, runId: string, runStartedAt: string | null = null): Cell {
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
  return assertCell(where, cell, runId, runStartedAt)
}

const STATE_SEVERITY: Record<ColumnFact["state"], number> = { problem: 4, undetermined: 3, pending: 2, pass: 1, info: 0 }

function finishLineCell(
  id: FinishLineId,
  column: ReportColumnId,
  facts: readonly ColumnFact[],
  runId: string,
  fallbackAt: string,
  unmeasured: ColumnInput["unmeasured"] = undefined,
  runStartedAt: string | null = null
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
  if (spec.fixedState === "info" && !(decider.state === "problem" && decider.reason === "test_error")) state = "info"
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
  return assertCell(where, cell, runId, runStartedAt)
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

/**
 * The `checks_passing` cell from one column's finish-line cells, against the row's label "Checks passing"
 * and the 14 checks: "4 pass · 8 problems · 2 not testable of 14" (an "· N unknown" segment when a check is
 * undetermined or pending, a "not testable" one when a check is not measured or info). The SEMANTICS are
 * §3i.4 / §3z.8's: the value is pass over N determinable (cells neither `not_measured` nor `info`), and
 * "unknown" = `undetermined` + `pending`; only the words name all 14, so the label and the cell never disagree.
 */
export function checksPassingCell(finishLine: Partial<Record<FinishLineId, Cell>>, runId: string, at: string): Cell {
  let pass = 0
  let problems = 0
  let unknown = 0
  let pending = 0
  for (const id of FINISH_LINE_IDS) {
    if (id === "consent_recorded" && !(finishLine[id]?.state === "problem" && finishLine[id]?.reason === "test_error")) continue // A failed wizard recording is its own problem, never a judgment on consent.
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
  const total = FINISH_LINE_IDS.length - (finishLine.consent_recorded?.state === "problem" && finishLine.consent_recorded.reason === "test_error" ? 0 : 1)
  const notTestable = total - determinable
  const words = [`${pass} pass`, `${problems} problem${problems === 1 ? "" : "s"}`, ...(unknown > 0 ? [`${unknown} unknown`] : []), ...(notTestable > 0 ? [`${notTestable} not testable`] : [])]
  return assertCell("rows.checks_passing", {
    value: `${pass}/${determinable}`,
    display: `${words.join(" · ")} of ${total}`,
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
  if (column === "live_today" && input.meta.sha !== null) throw new ReportRuleError(LIVE_TODAY_SHA_RULE)
  const at = input.meta.measuredAt ?? input.facts.map((fact) => fact.at).sort().at(-1) ?? input.builtAt ?? new Date(0).toISOString()
  const finishLine: Partial<Record<FinishLineId, Cell>> = {}
  for (const id of FINISH_LINE_IDS) finishLine[id] = finishLineCell(id, column, input.facts, input.runId, at, input.unmeasured, input.runStartedAt ?? null)
  const cells: Partial<Record<ReportRowId, Cell>> = {}
  for (const [rowId, rowInput] of Object.entries(input.rows) as Array<[ReportRowId, RowCellInput | undefined]>) {
    if (!rowInput) continue
    if (rowId === "checks_passing" || rowId === "day7_checkin") throw new ReportRuleError(`${column}: the ${rowId} row is computed, never given`)
    cells[rowId] = rowCell(`rows.${rowId}.${column}`, rowInput, input.runId, input.runStartedAt ?? null)
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
  // R2-4: "open Infinite" only when Infinite finishes it; `rerun_tag` (nothing in Infinite can) is "—" not exercised.
  if (pending === "open_infinite") return { reason: "pending_open_infinite", state: "pending" }
  return { reason: "not_exercised", state: "not_measured" }
}

function validateSnapshotCells(column: ReportColumnId, snapshot: ReportColumnSnapshot, runId: string, runStartedAt: string | null): void {
  for (const [rowId, cell] of Object.entries(snapshot.cells)) {
    if (cell) assertCell(`rows.${rowId}.${column}`, cell, runId, runStartedAt)
  }
  for (const [id, cell] of Object.entries(snapshot.finishLine) as Array<[FinishLineId, Cell | undefined]>) {
    if (!cell) continue
    assertCell(`finishLine.${id}.${column}`, cell, runId, runStartedAt)
    assertFinishLineSource(id, column, cell)
  }
}

export function buildReport(input: BuildInput, now: () => Date = () => new Date()): ReportV2 {
  input = { ...input, columns: Object.fromEntries(Object.entries(input.columns).map(([key, snapshot]) => {
    if (!snapshot) return [key, snapshot]
    const asInfo = (cell: Cell | undefined) => cell && (cell.state === "pass" || cell.state === "problem") && cell.reason !== "test_error" ? { ...cell, state: "info" as const } : cell
    const finishLine = { ...snapshot.finishLine, consent_recorded: asInfo(snapshot.finishLine.consent_recorded) }
    return [key, { ...snapshot, finishLine, cells: { ...snapshot.cells, consent_setting: asInfo(snapshot.cells.consent_setting), checks_passing: checksPassingCell(finishLine, input.runId, snapshot.meta.measuredAt ?? new Date(0).toISOString()) } }]
  })) as BuildInput["columns"] }
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
    if (snapshot) validateSnapshotCells(column, snapshot, runId, input.runStartedAt ?? null)
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
      // A pending-by-design cell (§3z.8: it waits for a real event or day 7) is pending for ITS OWN reason even
      // before its column is measured, as `finishLineCell` builds it when a measured column has no reading; the
      // cloud refuses `ga4_key_events_received × proven_live` with any reason but `needs_7_days` (round 3).
      const byDesign = spec.fixedState === "pending" && spec.reason !== undefined ? spec.reason : null
      cells[column] = spec.notMeasured
        ? dashCell("wizard_check", generatedAt, runId, spec.notMeasured)
        : cellFor(column, (snapshot) => snapshot.finishLine[id], () =>
            byDesign
              ? dashCell(FINISH_LINE_INPUT_PROVENANCE[spec.inputs[0]!], generatedAt, runId, byDesign, "pending")
              : { ...missing(column), provenance: { source: dashSource(id, column), at: generatedAt, runId } }
          )
    }
    return { n: index + 1, id, cells }
  })

  const leftGuards = (input.verdictFacts?.jobs ?? []).filter(job => job.jobId === "preview_guard" && job.state === "left_for_you" && (job.ownerBoundary?.kind === "frozen_unit" || job.ownerBoundary?.kind === "restored_unit"))
  const ownerPreviewNote = leftGuards.length ? `NOT DONE for ${[...new Set(leftGuards.map(job => ({ ga4: "GA4", meta: "Meta pixel", posthog: "PostHog" }[job.id.split(":")[1]!] ?? job.title)))].join(", ")}: left for the owner; preview and local visits keep counting` : null
  if (ownerPreviewNote) {
    // This is a wizard source-location fact, not a deployed browser measurement. The wire's proven
    // column accepts only desktop evidence, so retain it and show the owner annotation alongside it.
    const current = finishLine.find(line => line.id === "previews_silent")!.cells.in_pr
    if (current.state !== "problem") {
      const cell: Cell = { value: "not_done", display: ownerPreviewNote, state: "info", provenance: { source: "wizard_check", at: generatedAt, runId } }
      finishLine.find(line => line.id === "previews_silent")!.cells.in_pr = cell
      rows.find(row => row.id === "preview_share")!.cells.in_pr = cell
      rows.find(row => row.id === "checks_passing")!.cells.in_pr = checksPassingCell(Object.fromEntries(finishLine.map(line => [line.id, line.cells.in_pr])), runId, generatedAt)
    }
  }
  const activationNotes = consentActivationNotes(input.verdictFacts?.consentActivation)
  if (activationNotes.length) {
    // The wire has aggregate check rows, not dedicated Infinite/capture activation ids. Do not
    // leave an aggregate pass asserting activation while the required banner signal is untested.
    for (const column of ["in_pr", "proven_live"] as const) {
      for (const id of ["each_tool_once", "proof_from_real_visit"] as const) {
        const line = finishLine.find(entry => entry.id === id)!
        const cell = line.cells[column]
        if (cell.state === "pass") line.cells[column] = { ...cell, state: "info", display: activationNotes.join("; ") }
      }
      const live = rows.find(row => row.id === "live_test_per_tool")!
      if (live.cells[column].state === "pass") live.cells[column] = { ...live.cells[column], state: "info", display: activationNotes.join("; ") }
      rows.find(row => row.id === "checks_passing")!.cells[column] = checksPassingCell(Object.fromEntries(finishLine.map(line => [line.id, line.cells[column]])), runId, generatedAt)
    }
  }
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
    notes: [...new Set([
      ...activationNotes,
      ...(activationNotes.length ? ["Your banner connection is unverified in this run. Required-mode offline and browser checks supply a test grant; passing those checks does not confirm your banner signal."] : []),
      ...(input.verdictFacts?.consentActivation?.mode === "not_required" && (input.verdictFacts.consentActivation.infinite || input.verdictFacts.consentActivation.capture) ? ["This run's tag and ad-click capture collect by default, independently of other banners until you connect their yes/no signal to Infinite. An Infinite-recorded no and DNT/GPC without an explicit grant are respected."] : []),
      ...(input.verdictFacts?.tagNotInstalled ? ["Infinite’s tag is NOT installed by this run. Add the owner wiring before testing it live."] : []),
      ...(ownerPreviewNote ? [ownerPreviewNote] : []),
      ...input.notes.filter(note => !isOwnerBoundaryStatement(note)),
      ...(input.verdictFacts?.ownerPolicyFindings ?? []),
      ...(input.verdictFacts?.jobs ?? []).filter(job => job.state === "left_for_you" && job.ownerBoundary).map(job => job.note ?? (job.ownerBoundary?.kind === "restored_unit" ? "Put back: an edit reached code that handles consent." : `Not changed by us: ${job.ownerBoundary?.file ?? job.allow.files[0] ?? "the noted file"} is left for you.`)),
      ...(input.verdictFacts?.priorPolicyEdits || hasRecordedPolicyEdits(input.verdictFacts?.jobs ?? []) || hasLegacyOwnerHistory(input.notes) ? [LEGACY_OWNER_BOUNDARY] : [])
    ])],
    verdict: null
  }
  // §3x.6 THE verdict, from the finished columns and the run's facts (one predicate; every surface renders it).
  if (input.verdictFacts) {
    report.verdict = computeVerdict({
      site: input.site.productionHost ?? input.site.repoLabel,
      finishLine,
      provenLive: columnsMeta.proven_live,
      jobs: input.verdictFacts.jobs,
      openFindings: input.verdictFacts.openFindings,
      tools: input.verdictFacts.tools,
      installedUnknown: input.verdictFacts.installedUnknown
    })
  }
  if (input.verdictFacts?.tagNotInstalled && report.verdict) {
    report.verdict.state = "not_checked_live"
    report.verdict.headline = "Infinite’s tag is NOT installed by this run. Add the owner wiring before testing it live."
  }
  if (activationNotes.length && report.verdict?.state === "properly") {
    report.verdict.state = "unconfirmed"
    report.verdict.headline = `${input.site.productionHost ?? input.site.repoLabel}: ${activationNotes.join("; ")}`
  }
  const boundaryNotes = ownerBoundaryNotes(input.notes.filter(isOwnerBoundaryStatement).join("\n\n"), hasLegacyOwnerHistory(report.notes), input.verdictFacts?.ownerBoundary)
  report.notes = [...report.notes.filter(note => !isOwnerBoundaryStatement(note)), ...boundaryNotes]
  report.notes = boundedNotes(report.notes)
  assertReport(report, input.runStartedAt ?? null)
  return report
}

/** Every rule the whole report must satisfy; throws the first set of problems found. */
export function assertReport(report: ReportV2, runStartedAt: string | null = null): void {
  const problems = shapeErrors(report, REPORT_V2_SHAPE)
  if (!Array.isArray(report.notes) || report.notes.length > REPORT_NOTE_LIMIT || report.notes.some(note => typeof note !== "string" || note.length === 0 || note.length > REPORT_NOTE_MAX_CHARS)) problems.push("notes must contain at most 20 nonempty summaries of at most 300 characters")
  if (report.schema !== REPORT_SCHEMA) problems.push(`schema is ${JSON.stringify(report.schema)}`)
  if (report.rows.map((row) => row.id).join() !== REPORT_ROWS.map((row) => row.id).join()) problems.push("rows are not the §3i.4 rows in order")
  if (report.finishLine.map((line) => line.id).join() !== FINISH_LINE_IDS.join()) problems.push("finishLine is not the 14 ids in order")
  // §3i.1, as the cloud parser refuses it (final verify F17): the live site has no commit; the PR and the merge
  // columns carry a full 40-hex SHA or null.
  if (problems.length === 0) {
    if (report.columns.live_today.sha !== null) problems.push(LIVE_TODAY_SHA_RULE)
    for (const column of ["in_pr", "proven_live"] as const) {
      const sha = report.columns[column].sha
      if (sha !== null && !/^[0-9a-f]{40}$/.test(sha)) problems.push(`columns.${column}.sha must be a 40-hex commit SHA or null`)
    }
  }
  // §3x.6 the verdict obeys the same refusals as the cloud parser.
  if (problems.length === 0 && report.verdict) problems.push(...verdictErrors(report, report.verdict))
  if (problems.length > 0) throw new ReportRuleError(problems.join("; "))
  for (const row of report.rows) for (const column of REPORT_COLUMN_IDS) assertCell(`rows.${row.id}.${column}`, row.cells[column], report.runId, runStartedAt)
  for (const line of report.finishLine) {
    for (const column of REPORT_COLUMN_IDS) {
      assertCell(`finishLine.${line.id}.${column}`, line.cells[column], report.runId, runStartedAt)
      assertFinishLineSource(line.id, column, line.cells[column])
    }
  }
  if (report.day7.cell) assertCell("day7.cell", report.day7.cell, report.runId, runStartedAt)
}

// ---------------------------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------------------------

/**
 * One footnote per reason. A reason on a "—" or a pending cell is footnoted under "— / pending:"; a reason on
 * a value the table DOES show (raw counts below the sample floor) is footnoted on its own, so a footnote never
 * says a shown value was not measured.
 */
function footnotes(report: ReportV2): string[] {
  const missing = new Set<Reason>()
  const shown = new Set<Reason>()
  const visit = (cell: Cell) => {
    if (!cell.reason) return
    if (cell.value === null || cell.state === "pending") missing.add(cell.reason)
    else if (cell.reason === "below_sample_floor") shown.add(cell.reason)
  }
  for (const row of report.rows) for (const column of REPORT_COLUMN_IDS) visit(row.cells[column])
  return [
    ...REASONS.filter((reason) => missing.has(reason)).map((reason) => `${NULL_DISPLAY} / pending: ${REASON_TEXT[reason]}`),
    ...REASONS.filter((reason) => shown.has(reason)).map((reason) => sentence(REASON_TEXT[reason]))
  ]
}

function sentence(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

/** The report's own notes, then the footnotes, each said once (a note may already say a footnote's words). */
function notesAndFootnotes(report: ReportV2): string[] {
  return [...new Set([...report.notes.filter(note => !isOwnerBoundaryStatement(note)), ...footnotes(report)])]
}

function cellText(cell: Cell, ownerPreviewNote?: string): string {
  const measured = cell.value === null ? NULL_DISPLAY : cell.state === "pass" || cell.state === "info" || cell.display === STATE_WORDS[cell.state] ? cell.display : `${cell.display} (${STATE_WORDS[cell.state]})`
  return ownerPreviewNote && !measured.includes("NOT DONE") ? `${measured} · ${ownerPreviewNote}` : measured
}

function ownerPreviewNote(report: ReportV2): string | undefined {
  return report.notes.find(note => note.startsWith("NOT DONE for "))
}

function day7Text(report: ReportV2): string {
  const cell = report.day7.cell
  return cell ? cellText(cell) : `${NULL_DISPLAY} (${REASON_TEXT.needs_7_days})`
}

/** Plain word-wrap (the report's text has no styling): nothing is cut; a word wider than the room is hard-split. */
function wrapPlain(text: string, width: number): string[] {
  const room = Math.max(1, width)
  const lines: string[] = []
  let line = ""
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word
    while (rest.length > room) {
      if (line) {
        lines.push(line)
        line = ""
      }
      lines.push(rest.slice(0, room))
      rest = rest.slice(room)
    }
    if (!rest) continue
    if (!line) line = rest
    else if (line.length + 1 + rest.length <= room) line = `${line} ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }
  if (line || lines.length === 0) lines.push(line)
  return lines
}

/** `first` + the wrapped text; the lines after the first start under the text (a hanging indent). */
function hanging(first: string, text: string, width: number): string[] {
  const indent = " ".repeat(first.length)
  return wrapPlain(text, width - first.length).map((line, index) => `${index === 0 ? first : indent}${line}`.trimEnd())
}

export interface TerminalReportOptions {
  ownerBoundary?: OwnerBoundaryMeasurement
  ownerJobs?: readonly ChecklistItem[]
  /** The run's display id ("r-7f3c"): the ONE id the terminal shows (header bar, this title, the exit line). */
  displayId?: string | null
  /** From the run's start to now; shown as "9 min". Absent = not shown. */
  durationMs?: number | null
}

/** "under a minute", "9 min", "3 h", "2 days": how long the run took, in the largest honest unit. */
export function durationWords(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (ms < 60_000) return "under a minute"
  if (minutes < 120) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h`
  return `${Math.round(hours / 24)} days`
}

/**
 * §3x.6 The closing line IS the verdict's headline (`wizard/verdict.ts`, the one predicate). A report with no verdict
 * was not graded by the tag (the desktop's partial report): it says so, and never guesses one.
 */
export function verdictLine(report: ReportV2): string {
  const unwired = report.notes.find(note => note.startsWith("Infinite’s tag is NOT installed"))
  if (unwired) return unwired
  if (report.verdict) return report.verdict.headline
  const site = report.site.productionHost ?? report.site.repoLabel
  return `${site}: not graded yet · run npx infinite-tag to finish the live checks`
}

/**
 * Review P1-3: the words a reason opens with on report.md and the PR comment, one line per reason with its names.
 * `not_live` has none: the headline already says it ("not checked live yet").
 */
export const VERDICT_REASON_WORDS: Record<VerdictReasonKind, string | null> = {
  live_problem: "Problems on the live site",
  approved_fix_missing: "Approved fixes the wizard has not confirmed in the code",
  review_blocker_open: "Review blockers still open",
  tool_silent: "Sent nothing on the real visit",
  tool_without_receipt: "No receipt from the real visit",
  tool_not_connected: "Sending, but its ID is not checked (not connected in Infinite)",
  earlier_problem_unchecked: "Problems found before the merge and not re-checked after the deploy",
  receipt_not_in: "Receipts not in yet",
  installed_unknown: "The deployed code could not be read",
  not_live: null
}

/** The verdict's reasons as report lines (problems, unconfirmed and not-checked-live verdicts; never "properly"). */
export function verdictReasonLines(report: ReportV2): string[] {
  const verdict = report.verdict
  if (!verdict || verdict.state === "properly") return []
  return verdict.reasons.flatMap((entry) => {
    const words = VERDICT_REASON_WORDS[entry.kind]
    if (words === null || entry.names.length === 0) return []
    const more = entry.count > entry.names.length ? ` +${entry.count - entry.names.length} more` : ""
    return [`${words}: ${entry.names.join(", ")}${more}`]
  })
}

/**
 * Below this many columns each row is stacked (label, then one line per column); from it, a 3-column table.
 * 140 gives each column 34 characters, so most cells stay on one line; a 120-column terminal reads better stacked.
 */
export const TERMINAL_TABLE_MIN_COLUMNS = 140

/**
 * The terminal's closing text: the verdict line, then the before/after table. NOTHING is cut at any width (final
 * verify F2: cells used to end in "…" at about 30 characters, which hid "of 14"): from 140 columns it is a
 * 3-column table whose cells wrap inside their column; below that each row is stacked (the label, then one
 * wrapped line per column). Notes and footnotes wrap too.
 */
export function renderTerminal(report: ReportV2, width: number, options: TerminalReportOptions = {}): string {
  const lines: string[] = []
  const total = Math.max(20, Math.floor(width))
  const tableRows = report.rows.filter((row) => row.id !== "day7_checkin")
  const site = report.site.productionHost ?? report.site.repoLabel
  // One id everywhere the user looks: the display id when the caller has it, else the run id's first 8.
  const run = options.displayId ?? report.runId.slice(0, 8)
  const took = options.durationMs === undefined || options.durationMs === null ? null : durationWords(options.durationMs)
  lines.push(...hanging("◆ ", [verdictLine(report), `run ${run}`, ...(took ? [took] : [])].join(" · "), total))
  lines.push("")
  lines.push(...wrapPlain(`Before and after · ${site}`, total))
  if (total >= TERMINAL_TABLE_MIN_COLUMNS) {
    const gap = "  "
    const labelWidth = Math.min(32, Math.max(...tableRows.map((row) => row.label.length)))
    const columnWidth = Math.floor((total - labelWidth - gap.length * 3) / 3)
    const tableLine = (cells: readonly string[][]) => {
      const height = Math.max(...cells.map((cell) => cell.length))
      for (let index = 0; index < height; index += 1) {
        lines.push(cells.map((cell, column) => (cell[index] ?? "").padEnd(column === 0 ? labelWidth : columnWidth)).join(gap).trimEnd())
      }
    }
    tableLine([[""], ...REPORT_COLUMN_IDS.map((column) => wrapPlain(COLUMN_LABELS[column], columnWidth))])
    for (const row of tableRows) {
      tableLine([wrapPlain(row.label, labelWidth), ...REPORT_COLUMN_IDS.map((column) => wrapPlain(cellText(row.cells[column], row.id === "preview_share" && column !== "live_today" ? ownerPreviewNote(report) : undefined), columnWidth))])
    }
  } else {
    // The values line up under each other when the screen has the room for it.
    const labelPad = total >= 60 ? Math.max(...REPORT_COLUMN_IDS.map((column) => COLUMN_LABELS[column].length)) + 2 : 0
    for (const row of tableRows) {
      lines.push(...wrapPlain(row.label, total))
      for (const column of REPORT_COLUMN_IDS) {
        lines.push(...hanging(`  ${`${COLUMN_LABELS[column]}:`.padEnd(labelPad)} `, cellText(row.cells[column], row.id === "preview_share" && column !== "live_today" ? ownerPreviewNote(report) : undefined), total))
      }
    }
  }
  lines.push(...wrapPlain(withOwnerBoundary(report.notes.filter(isOwnerBoundaryStatement).join("\n\n"), hasLegacyOwnerHistory(report.notes), options.ownerBoundary), total))
  lines.push(...hanging("7 days later: ", day7Text(report), total))
  const activation = consentActivationFromNotes(report.notes)
  const handoff = activation && consentHandoff(activation)
  if (handoff) {
    lines.push("", "Owner action: banner signal", "", ...handoff.split("\n"))
    lines.push("", "Finish line", ...consentActivationNotes(activation))
  }
  for (const note of notesAndFootnotes(report)) lines.push(...hanging("", note, total))
  for (const instruction of ownerInstructions(options.ownerJobs ?? [])) {
    lines.push("", ...wrapPlain(instruction.note, total), ...wrapPlain(instruction.placement, total), "", "Full text in the pull request and .infinite/wizard/report.md")
  }
  return lines.join("\n")
}

function md(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")
}

/** The PR / app markdown: plain-text statuses, never a `- [ ]`. */
export function renderMarkdown(report: ReportV2, ownerBoundary?: OwnerBoundaryMeasurement, ownerJobs: readonly ChecklistItem[] = [], excludedLines: readonly string[] = []): string {
  const out: string[] = []
  const site = report.site.productionHost ?? report.site.repoLabel
  // Review P1-3: report.md and the PR comment open with THE verdict's headline (the terminal's own line) and its
  // reasons; a table of finish-line cells is never the only summary ("7 pass · 0 problems" hid run 3's problems).
  out.push(`**${md(verdictLine(report))}**`)
  const reasons = verdictReasonLines(report)
  if (reasons.length > 0) {
    out.push("")
    for (const line of reasons) out.push(`- ${md(line)}`)
  }
  out.push("")
  out.push(withOwnerBoundary(report.notes.filter(isOwnerBoundaryStatement).join("\n\n"), hasLegacyOwnerHistory(report.notes), ownerBoundary))
  out.push("")
  out.push(`### Before and after · ${md(site)}`)
  out.push("")
  out.push(`| | ${REPORT_COLUMN_IDS.map((column) => COLUMN_LABELS[column]).join(" | ")} |`)
  out.push(`|---|${REPORT_COLUMN_IDS.map(() => "---").join("|")}|`)
  for (const row of report.rows) {
    if (row.id === "day7_checkin") continue
    out.push(`| ${md(row.label)} | ${REPORT_COLUMN_IDS.map((column) => md(cellText(row.cells[column], row.id === "preview_share" && column !== "live_today" ? ownerPreviewNote(report) : undefined))).join(" | ")} |`)
  }
  out.push("")
  out.push(`**7 days later:** ${md(day7Text(report))}`)
  out.push("")
  out.push("<details><summary>Checks and recorded settings</summary>")
  out.push("")
  out.push(`| # | Check | ${REPORT_COLUMN_IDS.map((column) => COLUMN_LABELS[column]).join(" | ")} |`)
  out.push(`|---|---|${REPORT_COLUMN_IDS.map(() => "---").join("|")}|`)
  for (const line of report.finishLine) {
    out.push(`| ${line.n} | ${line.id.replace(/_/g, " ")} | ${REPORT_COLUMN_IDS.map((column) => md(cellText(line.cells[column], line.id === "previews_silent" && column !== "live_today" ? ownerPreviewNote(report) : undefined))).join(" | ")} |`)
  }
  const activation = consentActivationFromNotes(report.notes)
  for (const note of consentActivationNotes(activation)) {
    const label = note.slice(0, note.indexOf(":"))
    out.push(`| | ${label} | — | ${CONSENT_WAITING} | ${CONSENT_WAITING} |`)
  }
  out.push("")
  out.push("</details>")
  const handoff = activation && consentHandoff(activation)
  if (handoff) {
    out.push("", "**Owner action: banner signal**", "")
    for (const section of handoff.split("\n\n")) out.push(section.startsWith("Yes:\n") || section.startsWith("No or revoke:\n") ? `${section.slice(0, section.indexOf("\n"))}\n\n\`\`\`js\n${section.slice(section.indexOf("\n") + 1)}\n\`\`\`` : section, "")
  }
  const notes = notesAndFootnotes(report)
  if (notes.length > 0) {
    out.push("")
    for (const note of notes) out.push(`${md(note)}  `)
  }
  const ownerNoteScanner = createScanner({ literals: [], allowedIds: [] })
  for (const instruction of ownerInstructions(ownerJobs)) {
    const fence = "`".repeat(Math.max(3, ...[...instruction.snippet.matchAll(/`+/g)].map(match => match[0].length + 1)))
    out.push("", quoteDisplayNote(ownerNoteScanner, instruction.note), "", quoteDisplayNote(ownerNoteScanner, instruction.placement), "", `${fence}js`, instruction.snippet, fence)
  }
  if (excludedLines.length > 0) out.push("", "### You said no to", "", ...[...new Set(excludedLines)].map(line => `- ${md(line)}`))
  const text = out.join("\n")
  if (text.includes(FORBIDDEN_CHECKBOX)) throw new ReportRuleError("the markdown would contain a checkbox")
  return text
}

/** Copyable bytes are local wizard facts, never encoded as cloud notes or taken from agent prose. */
function ownerInstructions(jobs: readonly ChecklistItem[]): Array<{ note: string; placement: string; snippet: string }> {
  return jobs.flatMap(job => {
    const proof = job.ownerBoundary
    if (job.state !== "left_for_you" || !proof || (proof.kind !== "frozen_unit" && proof.kind !== "policy_page" && proof.kind !== "unproven_wiring")) return []
    const snippet = proof.guard ?? proof.wiring
    if (!snippet) return []
    const where = `${proof.file ?? job.allow.files[0] ?? "the noted file"}:${proof.line ?? 1}`
    return [{ note: job.note ?? `Not changed by us: ${where} is left for you.`, snippet,
      placement: proof.guard ? `For the site owner: apply this guard to the analytics start-up at ${where}. Keep consent checks, grants and revocations outside it. The wizard did not apply this snippet.`
        : `For the site owner: place this import, mount or script at ${where}. The wizard left the entrypoint unchanged; this wiring has not been applied.` }]
  })
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
