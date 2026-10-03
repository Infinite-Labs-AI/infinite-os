// The Infinite cloud's door rules, ported for the tests (final verify F17).
//
// The tag's report used to be checked only by the tag's own builder; the fake bridge answered 201 to any
// report, so a report the real cloud refuses (`columns.live_today.sha` = the base commit) passed every
// offline run and failed every real one at step 12. This file transcribes the cloud's rules, so the fake
// bridge refuses what the cloud refuses:
// - `parseCloudReport` is the cloud's `parseReportV2` (1bu-1 `src/lib/analytics/wizard/report-v2.ts`) and
//   the POST report route's own checks (`producer:"cloud"` is never accepted over HTTP);
// - `cloudPatchRefusal` is the cloud's `decodePatchRun` + `planRunPatch` rules that the bridge shape alone
//   does not carry (1bu-1 `src/lib/analytics/wizard/runs.ts`).
//
// It is a PORT, written from the cloud's source, not derived from the tag's own report contract: the id lists,
// the reasons and the §3i.7 table below are typed out again on purpose, so a drift between the tag's builder
// and the cloud shows up here instead of agreeing with itself. No 1bu-1 code is imported (this repo is public).

export const CLOUD_REPORT_SCHEMA = "infinite-tag.report.v2"
export const CLOUD_REPORT_PHASES = ["live_today", "in_pr", "proven_live", "day7"] as const
export const CLOUD_REPORT_PRODUCERS = ["tag", "desktop", "cloud"] as const
const COLUMNS = ["live_today", "in_pr", "proven_live"] as const
type Column = (typeof COLUMNS)[number]
type Phase = (typeof CLOUD_REPORT_PHASES)[number]
type Producer = (typeof CLOUD_REPORT_PRODUCERS)[number]

const CELL_STATES = ["pass", "problem", "undetermined", "info", "pending", "not_measured"] as const
const SOURCES = ["wizard_check", "desktop_test", "cloud_read", "cloud_receipt", "plan_answer", "git_host"] as const
type Source = (typeof SOURCES)[number]
const REASONS = [
  "not_connected",
  "needs_7_days",
  "via_tag_manager",
  "read_failed",
  "not_built",
  "below_sample_floor",
  "held_by_consent",
  "preview_protected",
  "env_dependent",
  "pending_deploy",
  "pending_open_infinite",
  "not_vercel",
  "automation_detected",
  "not_exercised",
  "not_probed",
  "waiting_real_event",
  "blocked_by_site_bot_rules",
  "test_error"
] as const
type Reason = (typeof REASONS)[number]
const ROW_IDS = [
  "checks_passing",
  "ga4_page_views_per_visit",
  "posthog_route",
  "meta_pixel",
  "preview_share",
  "server_conversions",
  "ga4_key_events",
  "consent_setting",
  "live_test_per_tool",
  "day7_checkin"
] as const
const FINISH_LINE_IDS = [
  "each_tool_once",
  "ids_match_connections",
  "previews_silent",
  "survives_ad_blockers",
  "spa_page_views",
  "conversions_server_side",
  "identity_joined",
  "utms_survive_redirects",
  "consent_recorded",
  "csp_allows",
  "ga4_key_events_received",
  "no_pii",
  "proof_from_real_visit",
  "keeps_being_checked"
] as const
type FinishLineId = (typeof FINISH_LINE_IDS)[number]

export const CLOUD_MAX_REPORT_JSON_BYTES = 56_000
const SAMPLE_FLOOR = 50
const NULL_DISPLAY = "—"
const MAX = { display: 200, value: 120, label: 80, checkId: 80, repoLabel: 200, host: 253, note: 300 } as const
const MAX_NOTES = 20

type Rule = { sources: readonly Source[]; fixedState?: "pending" | "info"; reason?: Reason } | { notMeasured: Reason }
const src = (...sources: Source[]): Rule => ({ sources })
const dash = (reason: Reason): Rule => ({ notMeasured: reason })
const fixed = (state: "pending" | "info", sources: Source[], reason?: Reason): Rule => (reason ? { sources, fixedState: state, reason } : { sources, fixedState: state })

/** The cloud's FINISH_LINE_RULES (§3i.7 as the cloud enforces it). */
const FINISH_LINE_RULES: Record<FinishLineId, Record<Column, Rule>> = {
  // §3x.6: production's own bytes after the deploy (wizard_check) beside the real visit.
  each_tool_once: { live_today: src("desktop_test", "wizard_check"), in_pr: src("desktop_test", "wizard_check"), proven_live: src("desktop_test", "wizard_check") },
  ids_match_connections: { live_today: src("wizard_check", "desktop_test"), in_pr: src("desktop_test"), proven_live: src("desktop_test") },
  previews_silent: { live_today: src("cloud_read"), in_pr: src("wizard_check", "desktop_test"), proven_live: src("desktop_test") },
  survives_ad_blockers: { live_today: src("wizard_check", "cloud_read"), in_pr: src("desktop_test", "wizard_check"), proven_live: src("cloud_receipt") },
  spa_page_views: { live_today: src("desktop_test"), in_pr: src("desktop_test"), proven_live: src("desktop_test") },
  conversions_server_side: { live_today: src("cloud_read"), in_pr: src("wizard_check"), proven_live: fixed("pending", ["cloud_read"]) },
  identity_joined: { live_today: src("wizard_check"), in_pr: src("wizard_check"), proven_live: fixed("pending", ["cloud_read"]) },
  utms_survive_redirects: { live_today: src("wizard_check"), in_pr: src("wizard_check", "desktop_test"), proven_live: src("wizard_check") },
  consent_recorded: { live_today: src("cloud_read"), in_pr: src("plan_answer", "cloud_read"), proven_live: src("cloud_read") },
  csp_allows: { live_today: src("wizard_check"), in_pr: src("desktop_test"), proven_live: src("wizard_check", "desktop_test") },
  ga4_key_events_received: { live_today: src("cloud_read"), in_pr: fixed("info", ["cloud_read"]), proven_live: fixed("pending", ["cloud_read"], "needs_7_days") },
  no_pii: { live_today: src("desktop_test"), in_pr: src("desktop_test", "wizard_check"), proven_live: src("desktop_test") },
  proof_from_real_visit: { live_today: dash("not_exercised"), in_pr: dash("not_exercised"), proven_live: src("cloud_receipt") },
  keeps_being_checked: { live_today: dash("not_exercised"), in_pr: src("plan_answer"), proven_live: src("cloud_read") }
}

export interface CloudReportContext {
  /** The run the path names (the cloud reads it from the database: the report's own runId must match). */
  runId: string
  /** The run's `started_at` on the cloud's clock (rule 3). */
  startedAt: string
  phase: Phase
  producer: Producer
  partial: boolean
}

/** `{ ok: true }`, or the field and the reason the cloud would answer with its 400 `invalid_request`. */
export type CloudReportResult = { ok: true } | { ok: false; field: string; reason: string }

class Refusal extends Error {
  constructor(
    readonly field: string,
    readonly reason: string
  ) {
    super(reason)
  }
}
function refuse(field: string, reason: string): never {
  throw new Refusal(field, reason)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
function object(value: unknown, field: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isPlainObject(value)) refuse(field, `${field} must be an object`)
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) refuse(`${field}.${key}`, `${field}.${key} is not a report field`)
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) refuse(`${field}.${key}`, `${field}.${key} is required`)
  return value
}
function text(value: unknown, field: string, max: number, min = 1): string {
  if (typeof value !== "string") refuse(field, `${field} must be a string`)
  if (value.length < min || value.length > max) refuse(field, `${field} must be ${min}–${max} characters`)
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) refuse(field, `${field} contains a control character`)
  return value
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
function instant(value: unknown, field: string): string {
  const s = text(value, field, 40)
  if (!ISO.test(s) || !Number.isFinite(Date.parse(s))) refuse(field, `${field} must be an ISO-8601 timestamp`)
  return s
}
const nullableInstant = (value: unknown, field: string) => (value === null ? null : instant(value, field))
function enumOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) refuse(field, `${field} must be one of: ${allowed.join(", ")}`)
  return value as T
}
function sha(value: unknown, field: string): void {
  if (value === null) return
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) refuse(field, `${field} must be a 40-hex commit SHA or null`)
}
function nonNegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) refuse(field, `${field} must be a non-negative number`)
  return value
}
function windowOf(value: unknown, field: string): void {
  const w = object(value, field, ["from", "to"])
  instant(w.from, `${field}.from`)
  instant(w.to, `${field}.to`)
}

const VERIFIED_WORD = /\b(verified|proven)\b/i
const ARROWS = /[←-⇿➔-➿⟰-⟿⤀-⥿⬀-⯿▲△▼▽►▶◀◄]|->|<-|=>/
const NOTHING_READ: ReadonlySet<string> = new Set(["read_failed", "not_connected"])

interface ParsedCell {
  value: string | number | null
  state: string
  source: string
  reason?: string
}

function parseCell(value: unknown, field: string, runId: string, startedAt: string): ParsedCell {
  const cell = object(value, field, ["value", "display", "state", "provenance"], ["reason", "raw"])
  let cellValue: string | number | null
  if (cell.value === null) cellValue = null
  else if (typeof cell.value === "string") cellValue = text(cell.value, `${field}.value`, MAX.value, 0)
  else if (typeof cell.value === "number" && Number.isFinite(cell.value)) cellValue = cell.value
  else refuse(`${field}.value`, `${field}.value must be a string, a finite number or null`)
  const display = text(cell.display, `${field}.display`, MAX.display)
  const state = enumOf(cell.state, `${field}.state`, CELL_STATES)

  const p = object(cell.provenance, `${field}.provenance`, ["source", "at", "runId"], ["checkId", "window", "receiptAt"])
  if (p.source === "agent") refuse(`${field}.provenance.source`, "no report cell may be computed from agent output")
  const source = enumOf(p.source, `${field}.provenance.source`, SOURCES)
  instant(p.at, `${field}.provenance.at`)
  const cellRunId = text(p.runId, `${field}.provenance.runId`, 36)
  if (p.checkId !== undefined) {
    const checkId = text(p.checkId, `${field}.provenance.checkId`, MAX.checkId)
    if (!/^[a-z0-9][a-z0-9_.:-]*$/.test(checkId)) refuse(`${field}.provenance.checkId`, `${field}.provenance.checkId is not a check id`)
  }
  if (p.window !== undefined) windowOf(p.window, `${field}.provenance.window`)
  const receiptAt = p.receiptAt === undefined ? undefined : instant(p.receiptAt, `${field}.provenance.receiptAt`)
  const reason = cell.reason === undefined ? undefined : enumOf(cell.reason, `${field}.reason`, REASONS)
  let raw: { numerator: number; denominator: number } | undefined
  if (cell.raw !== undefined) {
    const r = object(cell.raw, `${field}.raw`, ["numerator", "denominator"])
    raw = { numerator: nonNegative(r.numerator, `${field}.raw.numerator`), denominator: nonNegative(r.denominator, `${field}.raw.denominator`) }
  }

  // Rule 1.
  if (cellValue === null) {
    if (display !== NULL_DISPLAY) refuse(`${field}.display`, `a null value must display "${NULL_DISPLAY}"`)
    if (reason === undefined) refuse(`${field}.reason`, "a null value needs its footnote reason")
    if (state === "pass" || state === "problem") refuse(`${field}.state`, `an unmeasured ("${NULL_DISPLAY}") cell is never a ${state}`)
  } else {
    if (display === NULL_DISPLAY) refuse(`${field}.value`, `a "${NULL_DISPLAY}" display must carry a null value`)
    if (state === "not_measured") refuse(`${field}.value`, `a not_measured cell carries no value (it shows "${NULL_DISPLAY}", never 0)`)
    if (typeof cellValue === "number" && reason !== undefined && NOTHING_READ.has(reason)) refuse(`${field}.value`, `a cell whose reason is ${reason} read nothing, so it carries no number`)
  }
  // Rule 3.
  if (VERIFIED_WORD.test(display)) {
    if (receiptAt === undefined || cellRunId !== runId) refuse(`${field}.display`, '"verified" or "proven" needs a receipt from this run (provenance.receiptAt and this runId)')
    if (Date.parse(receiptAt) < Date.parse(startedAt)) refuse(`${field}.provenance.receiptAt`, '"verified" or "proven" needs a receipt from after this run started')
  }
  // Rule 5.
  if (ARROWS.test(display)) refuse(`${field}.display`, "a cell shows its own value, never an arrow or a delta")
  // Rule 4.
  if (display.includes("%")) {
    if (!raw) refuse(`${field}.raw`, "a percentage needs its raw counts (raw.numerator / raw.denominator)")
    if (raw.denominator < SAMPLE_FLOOR) refuse(`${field}.display`, `below ${SAMPLE_FLOOR} the display shows raw counts, never a percentage`)
  }
  return { value: cellValue, state, source, ...(reason ? { reason } : {}) }
}

function parseColumnCells(value: unknown, field: string, runId: string, startedAt: string): Record<Column, ParsedCell> {
  const cells = object(value, field, COLUMNS)
  return {
    live_today: parseCell(cells.live_today, `${field}.live_today`, runId, startedAt),
    in_pr: parseCell(cells.in_pr, `${field}.in_pr`, runId, startedAt),
    proven_live: parseCell(cells.proven_live, `${field}.proven_live`, runId, startedAt)
  }
}

function parseOrThrow(raw: unknown, ctx: CloudReportContext): void {
  // The route: the day-7 report is the cloud's own, never posted over HTTP.
  if (ctx.producer === "cloud") refuse("producer", "Only the Infinite cloud writes the day-7 report.")
  if (ctx.producer === "tag" && ctx.partial) refuse("partial", "a tag report is never partial")
  if (ctx.producer === "desktop" && (!ctx.partial || ctx.phase !== "proven_live")) refuse("partial", "a desktop report is only ever a partial proven_live report")
  if ((ctx.producer as string) === "cloud" !== (ctx.phase === "day7")) refuse("producer", "the day7 report comes only from the cloud, and the cloud writes only day7")

  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > CLOUD_MAX_REPORT_JSON_BYTES) refuse("report", `the report may be at most ${CLOUD_MAX_REPORT_JSON_BYTES} bytes`)
  const r = object(raw, "report", ["schema", "runId", "tagVersion", "generatedAt", "site", "columns", "rows", "day7", "finishLine", "notes", "verdict"])
  if (r.schema !== CLOUD_REPORT_SCHEMA) refuse("report.schema", `report.schema must be "${CLOUD_REPORT_SCHEMA}"`)
  if (r.runId !== ctx.runId) refuse("report.runId", "report.runId must be this run's id")

  const site = object(r.site, "report.site", ["repoLabel", "productionHost"])
  const columns = object(r.columns, "report.columns", COLUMNS)
  const liveToday = object(columns.live_today, "report.columns.live_today", ["measuredAt", "sha"])
  if (liveToday.sha !== null) refuse("report.columns.live_today.sha", "the live site today has no commit SHA")
  const inPr = object(columns.in_pr, "report.columns.in_pr", ["measuredAt", "sha"])
  const provenLive = object(columns.proven_live, "report.columns.proven_live", ["measuredAt", "sha", "pending"])
  text(r.tagVersion, "report.tagVersion", 32)
  instant(r.generatedAt, "report.generatedAt")
  text(site.repoLabel, "report.site.repoLabel", MAX.repoLabel)
  if (site.productionHost !== null) text(site.productionHost, "report.site.productionHost", MAX.host)
  nullableInstant(liveToday.measuredAt, "report.columns.live_today.measuredAt")
  nullableInstant(inPr.measuredAt, "report.columns.in_pr.measuredAt")
  sha(inPr.sha, "report.columns.in_pr.sha")
  nullableInstant(provenLive.measuredAt, "report.columns.proven_live.measuredAt")
  sha(provenLive.sha, "report.columns.proven_live.sha")
  if (provenLive.pending !== null) enumOf(provenLive.pending, "report.columns.proven_live.pending", ["deploy", "open_infinite", "rerun_tag"] as const)

  const rows: Array<{ id: string; cells: Record<Column, ParsedCell> }> = []
  if (!Array.isArray(r.rows) || r.rows.length !== ROW_IDS.length) refuse("report.rows", `report.rows must hold the ${ROW_IDS.length} fixed rows`)
  const seenRows = new Set<string>()
  ;(r.rows as unknown[]).forEach((value, i) => {
    const row = object(value, `report.rows[${i}]`, ["id", "label", "cells"])
    const id = enumOf(row.id, `report.rows[${i}].id`, ROW_IDS)
    if (seenRows.has(id)) refuse(`report.rows[${i}].id`, `row ${id} appears twice`)
    seenRows.add(id)
    text(row.label, `report.rows[${i}].label`, MAX.label)
    rows.push({ id, cells: parseColumnCells(row.cells, `report.rows[${i}].cells`, ctx.runId, ctx.startedAt) })
  })

  const finishLine: Array<{ id: FinishLineId; cells: Record<Column, ParsedCell> }> = []
  if (!Array.isArray(r.finishLine) || r.finishLine.length !== FINISH_LINE_IDS.length) refuse("report.finishLine", `report.finishLine must hold the ${FINISH_LINE_IDS.length} finish-line checks`)
  const seenFinish = new Set<string>()
  ;(r.finishLine as unknown[]).forEach((value, i) => {
    const item = object(value, `report.finishLine[${i}]`, ["n", "id", "cells"])
    const id = enumOf(item.id, `report.finishLine[${i}].id`, FINISH_LINE_IDS)
    if (seenFinish.has(id)) refuse(`report.finishLine[${i}].id`, `finish-line check ${id} appears twice`)
    seenFinish.add(id)
    if (item.n !== FINISH_LINE_IDS.indexOf(id) + 1) refuse(`report.finishLine[${i}].n`, `${id} is check number ${FINISH_LINE_IDS.indexOf(id) + 1}`)
    finishLine.push({ id, cells: parseColumnCells(item.cells, `report.finishLine[${i}].cells`, ctx.runId, ctx.startedAt) })
  })

  // §3x.6 the verdict: required on every tag report, null on the desktop's partial; the refusals 1bu-1 mirrors.
  if (ctx.producer === "tag" && (r.verdict === null || r.verdict === undefined)) refuse("report.verdict", "a tag report carries its verdict")
  if (ctx.producer === "desktop" && r.verdict !== null) refuse("report.verdict", "a desktop partial report carries no verdict")
  if (r.verdict !== null && r.verdict !== undefined) {
    const verdict = object(r.verdict, "report.verdict", ["state", "headline", "reasons", "installed"])
    const state = enumOf(verdict.state, "report.verdict.state", ["properly", "problems", "unconfirmed", "not_checked_live"] as const)
    text(verdict.headline, "report.verdict.headline", 600)
    if (/\b(?:verified|proven)\b/i.test(verdict.headline as string)) refuse("report.verdict.headline", 'a verdict headline never says "verified" or "proven"')
    if (!Array.isArray(verdict.reasons)) refuse("report.verdict.reasons", "reasons is a list")
    const kinds = (verdict.reasons as unknown[]).map((entry, i) => {
      const reason = object(entry, `report.verdict.reasons[${i}]`, ["kind", "count", "names"])
      return enumOf(reason.kind, `report.verdict.reasons[${i}].kind`, ["live_problem", "approved_fix_missing", "review_blocker_open", "tool_silent", "tool_without_receipt", "tool_not_connected", "earlier_problem_unchecked", "not_live"] as const)
    })
    const finish = Array.isArray(r.finishLine) ? (r.finishLine as Array<{ id?: unknown; cells?: { proven_live?: { state?: unknown } } }>) : []
    if (state === "properly") {
      if (finish.some((line) => line.cells?.proven_live?.state === "problem")) refuse("report.verdict.state", '"properly" with a Proven-live problem cell')
      if (finish.find((line) => line.id === "proof_from_real_visit")?.cells?.proven_live?.state !== "pass") refuse("report.verdict.state", '"properly" without a passing proof from the real visit')
      if (kinds.length > 0) refuse("report.verdict.reasons", '"properly" with reasons')
    }
    if (state === "problems" && !kinds.some((kind) => ["live_problem", "approved_fix_missing", "review_blocker_open", "tool_silent", "tool_without_receipt"].includes(kind))) {
      refuse("report.verdict.state", '"problems" without a problems-class reason')
    }
  }

  const day7 = object(r.day7, "report.day7", ["measuredAt", "window", "cell"])
  nullableInstant(day7.measuredAt, "report.day7.measuredAt")
  if (day7.window !== null) windowOf(day7.window, "report.day7.window")
  const day7Cell = day7.cell === null ? null : parseCell(day7.cell, "report.day7.cell", ctx.runId, ctx.startedAt)

  if (!Array.isArray(r.notes) || r.notes.length > MAX_NOTES) refuse("report.notes", `report.notes must be a list of at most ${MAX_NOTES}`)
  ;(r.notes as unknown[]).forEach((note, i) => text(note, `report.notes[${i}]`, MAX.note))

  if (ctx.producer === "desktop") {
    const visit = (cell: ParsedCell, field: string, receiptCell: boolean) => {
      if (cell.source !== "cloud_receipt") refuse(`${field}.provenance.source`, "a desktop report may only copy cloud receipt states (source cloud_receipt)")
      if (!receiptCell && (cell.state !== "pending" || cell.value !== null || cell.reason !== "pending_open_infinite")) {
        refuse(`${field}.state`, "outside live_test_per_tool × proven_live, a desktop report leaves every cell pending (pending_open_infinite)")
      }
    }
    rows.forEach((row, i) => COLUMNS.forEach((column) => visit(row.cells[column], `report.rows[${i}].cells.${column}`, row.id === "live_test_per_tool" && column === "proven_live")))
    finishLine.forEach((item, i) => COLUMNS.forEach((column) => visit(item.cells[column], `report.finishLine[${i}].cells.${column}`, false)))
    if (day7Cell) visit(day7Cell, "report.day7.cell", false)
    return
  }
  finishLine.forEach((item, i) => {
    for (const column of COLUMNS) {
      const rule = FINISH_LINE_RULES[item.id][column]
      const cell = item.cells[column]
      const field = `report.finishLine[${i}].cells.${column}`
      if ("notMeasured" in rule) {
        if (cell.value !== null || cell.state !== "not_measured" || cell.reason !== rule.notMeasured) refuse(field, `${item.id} × ${column} is not measured ("—", reason ${rule.notMeasured})`)
        continue
      }
      if (cell.value !== null && !rule.sources.includes(cell.source as Source)) refuse(`${field}.provenance.source`, `${item.id} × ${column} may only be computed from: ${rule.sources.join(", ")}`)
      if (rule.fixedState === "info" && cell.state !== "info" && !(cell.value === null && cell.state === "not_measured")) refuse(`${field}.state`, `${item.id} × ${column} is info (designated only), never ${cell.state}`)
      if (rule.fixedState === "pending") {
        if (cell.state !== "pending" && cell.state !== "pass" && cell.state !== "problem") refuse(`${field}.state`, `${item.id} × ${column} is pending until its input settles it, never ${cell.state}`)
        if (cell.state === "pending" && cell.value === null && rule.reason !== undefined && cell.reason !== rule.reason) refuse(`${field}.reason`, `${item.id} × ${column} waits for ${rule.reason}`)
      }
    }
  })
}

/** The cloud's verdict on one POSTed report (`{phase, producer, partial, report}` for run `ctx.runId`). */
export function parseCloudReport(raw: unknown, ctx: CloudReportContext): CloudReportResult {
  try {
    parseOrThrow(raw, ctx)
    return { ok: true }
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, field: error.field, reason: error.reason }
    throw error
  }
}

// ── runs.patch: the cloud rules the bridge shape does not carry ───────────────────────────────────────

const CONVERSION_NAME = /^[a-z][a-z0-9_]{0,63}$/
const SHA40 = /^[0-9a-f]{40}$/
const MAX_RUN_CONVERSIONS = 20

export interface CloudRunRow {
  phase: "before" | "in_pr" | "merged" | "proven" | "abandoned"
  proofState: string
  proofClaimedBy: "tag" | "desktop" | null
  clickTestedConversions: readonly string[]
}

/**
 * The 400 the cloud answers for a PATCH body the bridge's shape accepts (`decodePatchRun`'s bounds and
 * `planRunPatch`'s 400s; the 409s and the phase order stay with the fake bridge's own rules). null = accepted.
 */
export function cloudPatchRefusal(body: { patch?: Record<string, unknown>; producer?: unknown }, row: CloudRunRow): { field: string; reason: string } | null {
  const patch = body.patch ?? {}
  if (Object.keys(patch).length === 0) return { field: "patch", reason: "patch must name at least one field." }
  for (const key of ["approvedConversions", "clickTestedConversions"] as const) {
    const names = patch[key]
    if (names === undefined) continue
    if (!Array.isArray(names) || names.length > MAX_RUN_CONVERSIONS || names.some((name) => typeof name !== "string" || !CONVERSION_NAME.test(name))) {
      return { field: `patch.${key}`, reason: `at most ${MAX_RUN_CONVERSIONS} names, each ${CONVERSION_NAME.source}` }
    }
  }
  for (const key of ["prHeadSha", "mergeSha"] as const) {
    if (patch[key] !== undefined && (typeof patch[key] !== "string" || !SHA40.test(patch[key] as string))) return { field: `patch.${key}`, reason: `${key} is a 40-hex SHA` }
  }
  if (patch.prNumber !== undefined && (!Number.isInteger(patch.prNumber) || (patch.prNumber as number) < 1)) return { field: "patch.prNumber", reason: "prNumber is a positive integer" }
  if (patch.mergedAt !== undefined && (typeof patch.mergedAt !== "string" || !ISO.test(patch.mergedAt))) return { field: "patch.mergedAt", reason: "mergedAt is an ISO instant" }
  if (patch.proofState !== undefined) {
    if (!["proven", "problem", "undetermined"].includes(patch.proofState as string)) return { field: "patch.proofState", reason: "proofState is proven, problem or undetermined" }
    if (body.producer === undefined) return { field: "producer", reason: "A proof result names its producer (tag or desktop)." }
  }
  if (Array.isArray(patch.clickTestedConversions)) {
    const union = new Set([...row.clickTestedConversions, ...(patch.clickTestedConversions as string[])])
    if (union.size > MAX_RUN_CONVERSIONS) return { field: "patch.clickTestedConversions", reason: `A run records at most ${MAX_RUN_CONVERSIONS} click-tested conversions.` }
  }
  if (patch.phase === "proven" && row.phase !== "proven") {
    const proof = row.proofState === "proving" && typeof patch.proofState === "string" ? patch.proofState : row.proofState
    if (proof === "pending" || proof === "pending_desktop") return { field: "patch.phase", reason: "phase proven needs a proof; this run has not been proven yet." }
  }
  return null
}
