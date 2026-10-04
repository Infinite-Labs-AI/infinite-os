// The "Live site today" column's INPUTS (lane O8, review P1-2): a pure mapping from what `before`
// measured to the typed readings lane O1's column builder (`buildColumn("live_today", input)`) turns into
// cells. This file computes NO cell: every reading names its §3i.7 FINISH_LINE_SOURCES input (so its
// provenance is fixed by FINISH_LINE_INPUT_PROVENANCE) or, for a row, a §3i.2 provenance source. Nothing
// here reads agent output.
//
// Honesty rules kept here:
// - an unmeasured value is `null` with one reason (never 0); a measured zero is a real 0;
// - `undetermined` (held by consent, bot rules, a test error) is never a problem and never a pass;
// - a share below 50 page views carries raw counts (the builder shows "3 of 41").
//
// The shapes mirror lane O1's `ColumnFact` / `RowCellInput` / `ColumnInput` (structurally identical), so
// `before` hands this to O1's builder through `BeforeStepOptions.buildLiveTodayColumn` with no adapter.
import type { CheckResult, CensusResult } from "./contracts/jobs.js"
import type { BaselineResponseFields, FinishLineInput, ProvenanceSource, Reason, ReportColumnMeta, ReportRowId } from "./contracts/report.js"
import type { TagKeys } from "./contracts/bridge.js"

/** §3x.6 (A7) The T1 checks that compare a live id with the connection's (finish-line 2's `t1.live_bytes`). */
const LIVE_ID_CHECKS: ReadonlySet<string> = new Set(["ga4_loader_id", "posthog_live_init", "meta_live_init", "infinite_runtime_once"])
import type { TestExpect, TestResult, TestTool } from "./contracts/test-engine.js"

/** One reading of a §3i.7 finish-line input (O1 `ColumnFact`). */
export interface LiveTodayFact {
  input: FinishLineInput
  state: "pass" | "problem" | "undetermined" | "info" | "pending"
  display?: string
  at: string
  checkId?: string
  window?: { from: string; to: string }
  reason?: Reason
}

/** One row cell input (O1 `RowCellInput`). */
export interface LiveTodayRow {
  value: string | number | null
  display?: string
  state: "pass" | "problem" | "undetermined" | "info" | "pending" | "not_measured"
  source: ProvenanceSource
  at: string
  checkId?: string
  window?: { from: string; to: string }
  reason?: Reason
  raw?: { numerator: number; denominator: number }
}

/** O1 `ColumnInput` for the live_today column. */
export interface LiveTodayColumnInput {
  runId: string
  meta: ReportColumnMeta
  facts: LiveTodayFact[]
  rows: Partial<Record<Exclude<ReportRowId, "checks_passing" | "day7_checkin">, LiveTodayRow>>
}

/** What the mapping reads (all of it is in `.infinite/wizard/before.json`). */
export interface LiveTodaySource {
  runId: string
  measuredAt: string
  keys: TagKeys
  expect: TestExpect
  census: CensusResult
  dryLive: TestResult | null
  grades: Partial<Record<TestTool, CheckResult>> | null
  liveChecks: readonly CheckResult[]
  baseline: BaselineResponseFields | null
  /** The repeated-init duplicates `before` found (tool → how many inits for one id). */
  repeatedInits: Array<{ tool: TestTool; id: string; count: number }>
  /** A login exists (auth detector): identity joining applies. */
  loginFound: boolean
  /** The dry load asked for a single-page navigation. */
  spaNavigationRequested: boolean
}

const TOOL_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta pixel" }
/** Grade reasons that mean "does not fire exactly once" (the rest are about something else). */
const ONCE_REASONS = new Set(["duplicate_page_view", "no_beacon", "meta_tr_rejected", "traffic_permissions_blocked"])

/** The grader's undetermined reasons → the report's reasons. */
const UNDETERMINED_REASON: Record<string, Reason> = {
  held_by_consent: "held_by_consent",
  automation_detected: "automation_detected",
  blocked_by_site_bot_rules: "automation_detected",
  preview_protected: "preview_protected",
  env_dependent: "env_dependent",
  not_connected: "not_connected",
  test_error: "not_exercised"
}

/**
 * The code of a grade's reason. The grader (lane O6) writes `<code> — <detail>` ("duplicate_page_view — 2 page
 * views per visit"); every comparison here is against the code alone. Comparing the whole string never matched,
 * so a real grade read as "a problem" in words and as `undetermined` in the column (terminal QA #17).
 */
export function gradeReasonCode(check: Pick<CheckResult, "reason"> | undefined | null): string {
  return (check?.reason ?? "").split(" — ")[0]!.trim()
}

/** Short, plain words for a grade's reason (the design's "blocked on www…", never a raw code). */
export function gradeWords(check: CheckResult, host: string | null): string {
  switch (gradeReasonCode(check)) {
    case "traffic_permissions_blocked":
      return host ? `blocked on ${host}` : "blocked by Traffic Permissions"
    case "meta_tr_rejected":
      return "rejected by Meta"
    case "duplicate_page_view":
      return "counts every page twice"
    case "no_beacon":
      return "not firing"
    case "wrong_id":
      return "uses an ID that is not your connection's"
    case "no_pii":
      return "sends personal data"
    case "held_by_consent":
      return "waits for consent (not counted as a problem)"
    case "previews_send_data":
      return "fires on previews"
    default:
      // A problem whose code has no words above still says something a person can act on, never "a problem".
      return check.state === "pass" ? "fires once" : check.state === "problem" ? "did not pass the live test" : "unknown"
  }
}

function expectedTools(expect: TestExpect): TestTool[] {
  return (["infinite", "ga4", "posthog", "meta"] as const).filter((tool) => expect[tool] !== undefined)
}

function share(split: { production: number; preview: number; other: number }): { numerator: number; denominator: number } {
  return { numerator: split.preview, denominator: split.production + split.preview + split.other }
}

function previewSplit(baseline: BaselineResponseFields | null): { production: number; preview: number; other: number } | null {
  if (!baseline) return null
  if (baseline.ga4.status === "ok" && baseline.ga4.pageViews) return baseline.ga4.pageViews
  if (baseline.posthog.status === "ok" && baseline.posthog.pageViews) return baseline.posthog.pageViews
  return null
}

function baselineReason(baseline: BaselineResponseFields | null, status: "ok" | "not_connected" | "read_failed" | undefined): Reason {
  if (!baseline) return "read_failed"
  return status === "not_connected" ? "not_connected" : "read_failed"
}

/** Pure: the live_today column's readings and row inputs from `before`'s facts. */
export function liveTodayColumnInput(source: LiveTodaySource): LiveTodayColumnInput {
  const at = source.measuredAt
  const facts: LiveTodayFact[] = []
  const tools = expectedTools(source.expect)
  const grades = source.grades ?? {}
  const host = source.dryLive?.loads[0]?.finalUrl ? new URL(source.dryLive.loads[0].finalUrl).hostname : null

  // 1 each_tool_once: the dry load's grades + the census.
  for (const tool of tools) {
    const grade = grades[tool]
    if (!grade) continue
    const state: LiveTodayFact["state"] =
      grade.state === "pass" ? "pass" : grade.state === "info" ? "info" : grade.state === "problem" && ONCE_REASONS.has(gradeReasonCode(grade)) ? "problem" : "undetermined"
    const reason = grade.state === "undetermined" ? UNDETERMINED_REASON[gradeReasonCode(grade)] : undefined
    facts.push({ input: "dry_live.graded", state, display: `${TOOL_LABEL[tool]}: ${gradeWords(grade, host)}`, at, checkId: grade.checkId, ...(reason ? { reason } : {}) })
    // 2 ids_match_connections (dry load half).
    const ids: LiveTodayFact["state"] = grade.state === "pass" ? "pass" : grade.state === "problem" && gradeReasonCode(grade) === "wrong_id" ? "problem" : "undetermined"
    facts.push({ input: "dry_live.ids_vs_keys", state: ids, display: `${TOOL_LABEL[tool]}: ${ids === "pass" ? "your connection's ID" : ids === "problem" ? "an ID that is not your connection's" : "not determinable"}`, at, checkId: grade.checkId })
  }
  if (source.census.entries.length > 0) {
    const repeated = source.repeatedInits
    // R4-13 (live run 4): "GA4 set up 2 times (problem)" sat next to "GA4 page views per visit 1". Both were true: gtag
    // drops a second config of the SAME id, so the copy cost code, not data. Said only when this load measured it (LF4-P3-2:
    // the no-send dry load counts what the page TRIED to send; every beacon was cancelled, so GA4 received nothing).
    const ga4PerVisit = ga4PageViewsPerVisit(source.dryLive)
    const words = (entry: (typeof repeated)[number]) =>
      entry.tool === "ga4" && ga4PerVisit === 1
        ? `${TOOL_LABEL[entry.tool]} set up ${entry.count} times with the same ID (the page tried to send 1 page view per visit in Infinite's no-send test, which GA4 never received: the copy costs code, not data)`
        : `${TOOL_LABEL[entry.tool]} set up ${entry.count} times`
    facts.push(
      repeated.length > 0
        ? { input: "census", state: "problem", display: repeated.map(words).join(", "), at }
        : { input: "census", state: "pass", display: "one setup per tool in the code", at }
    )
  }

  // T1 readings (1 duplicates, 2 ids, 4 ad blockers, 8 redirects, 10 CSP).
  for (const check of source.liveChecks) {
    // §3x.6 (A7): `byte_census` is the DUPLICATE check (each tool once); the four ID checks are what "IDs match
    // connections" reads. Run 3 fed the duplicate check into the ID row and dropped the ID checks.
    const input: FinishLineInput | null =
      check.checkId === "byte_census"
        ? "t1.byte_census"
        : LIVE_ID_CHECKS.has(check.checkId)
          ? "t1.live_bytes"
        : check.checkId === "posthog_proxy"
          ? "t1.proxy"
          : check.checkId === "redirect_walk"
            ? "t1.redirect_walk"
            : check.checkId === "csp_header" || check.checkId === "csp"
              ? "t1.csp"
              : null
    if (input === null) continue
    facts.push({ input, state: check.state, at: check.at, checkId: check.checkId })
  }

  // 3 previews_silent.
  const split = previewSplit(source.baseline)
  const window = source.baseline ? { from: source.baseline.window.from, to: source.baseline.window.to } : undefined
  if (split) {
    const raw = share(split)
    facts.push({ input: "baseline.preview_share", state: raw.numerator > 0 ? "problem" : "pass", display: `${raw.numerator} of ${raw.denominator} page views from previews`, at, ...(window ? { window } : {}) })
  }

  // 4 survives_ad_blockers (the server lane half).
  const laneState = source.baseline?.serverLane.laneState ?? null
  if (laneState !== null) {
    facts.push({ input: "baseline.server_lane_state", state: laneState === "receiving" ? "pass" : "problem", display: laneState === "receiving" ? "server lane receiving" : "server lane not receiving", at })
  }

  // 5 spa_page_views.
  const dry = source.dryLive
  if (dry && source.spaNavigationRequested && source.expect.ga4) {
    const navigated = dry.ga4.events.some((event) => event.afterNav) || dry.infinite.events.some((event) => event.nav)
    const pageViewAfter = dry.ga4.events.some((event) => event.afterNav && event.en === "page_view")
    facts.push(
      !navigated
        ? { input: "dry_live.spa_navigation", state: "undetermined", display: "no page change observed", at, reason: "not_exercised" }
        : { input: "dry_live.spa_navigation", state: pageViewAfter ? "pass" : "problem", display: pageViewAfter ? "GA4 counts page changes" : "GA4 misses page changes", at }
    )
  }

  // 6 conversions_server_side.
  const outcomes = source.baseline?.serverLane.outcomes7d ?? null
  if (outcomes !== null) facts.push({ input: "baseline.server_lane_outcomes", state: outcomes > 0 ? "pass" : "problem", display: `${outcomes} sent from the server in 7 days`, at })
  const infiniteConversions = source.baseline?.conversions.infinite ?? null
  if (infiniteConversions !== null) {
    const total = infiniteConversions.reduce((sum, entry) => sum + entry.count, 0)
    facts.push({ input: "baseline.conversions_infinite", state: total > 0 ? "pass" : "problem", display: `${total} conversions recorded`, at, ...(window ? { window } : {}) })
  }

  // 7 identity_joined.
  const identified = source.census.identify.identifyCalls.length > 0
  const reset = source.census.identify.resetCalls.length > 0
  facts.push(
    !source.loginFound
      ? { input: "census.identify_reset", state: "info", display: "no login found", at }
      : { input: "census.identify_reset", state: identified && reset ? "pass" : "problem", display: identified && reset ? "visits joined to accounts" : "visits not joined to accounts", at }
  )

  // 9 consent_recorded.
  const consent = source.keys.infinite.consentMode
  facts.push({ input: "keys.consent_mode", state: consent ? "pass" : "problem", display: consent ? consentWords(consent) : "not recorded", at })

  // 11 ga4_key_events_received.
  const keyEvents = source.baseline?.ga4.keyEvents ?? null
  if (keyEvents !== null) {
    const designated = keyEvents.filter((event) => event.designated)
    const received = designated.filter((event) => (event.received28d ?? 0) > 0)
    facts.push({
      input: "baseline.key_events",
      state: received.length > 0 ? "pass" : "problem",
      display: designated.length === 0 ? "no key events marked" : `${received.length} of ${designated.length} key events received`,
      at,
      ...(window ? { window } : {})
    })
  }

  // 12 no_pii.
  if (dry) {
    const piiCount = dry.pii.reduce((sum, entry) => sum + entry.count, 0)
    const flagged = Object.values(grades).some((grade) => grade?.state === "problem" && gradeReasonCode(grade) === "no_pii")
    facts.push({ input: "dry_live.pii", state: piiCount > 0 || flagged ? "problem" : "pass", display: piiCount > 0 || flagged ? "personal data seen in a request" : "no personal data in any request", at })
  }

  return {
    runId: source.runId,
    // §3i.1: the live site today has no commit SHA (the cloud refuses any other value); the column is keyed to
    // when it was measured, never to the branch's base commit (final verify F17).
    meta: { measuredAt: at, sha: null },
    facts,
    rows: rowsFor(source, tools, grades, host, split, window)
  }
}

/** The most GA4 page views one load of the no-send test sent (its first page; a page change is not counted); null = no load. */
function ga4PageViewsPerVisit(dry: LiveTodaySource["dryLive"]): number | null {
  if (!dry) return null
  const perLoad = new Map<string, number>()
  for (const event of dry.ga4.events) if (event.en === "page_view" && !event.afterNav) perLoad.set(event.loadLabel, (perLoad.get(event.loadLabel) ?? 0) + 1)
  return Math.max(0, ...perLoad.values())
}

function consentWords(mode: "not_required" | "required"): string {
  return mode === "required" ? "ask first (consent required)" : "collect by default"
}

function rowsFor(
  source: LiveTodaySource,
  tools: readonly TestTool[],
  grades: Partial<Record<TestTool, CheckResult>>,
  host: string | null,
  split: { production: number; preview: number; other: number } | null,
  window: { from: string; to: string } | undefined
): LiveTodayColumnInput["rows"] {
  const at = source.measuredAt
  const dry = source.dryLive
  const rows: LiveTodayColumnInput["rows"] = {}
  const unmeasured = (src: ProvenanceSource, reason: Reason, state: LiveTodayRow["state"] = "not_measured"): LiveTodayRow => ({ value: null, state, source: src, at, reason })
  const heldOrUnknown = (tool: TestTool): LiveTodayRow | null => {
    const grade = grades[tool]
    if (grade?.state !== "undetermined") return null
    return unmeasured("desktop_test", UNDETERMINED_REASON[gradeReasonCode(grade)] ?? "not_exercised", "undetermined")
  }

  // GA4 page views per visit.
  if (!source.expect.ga4) rows.ga4_page_views_per_visit = unmeasured("desktop_test", "not_connected")
  else if (!dry) rows.ga4_page_views_per_visit = unmeasured("desktop_test", "not_exercised")
  else {
    const held = heldOrUnknown("ga4")
    if (held) rows.ga4_page_views_per_visit = held
    else {
      const most = ga4PageViewsPerVisit(dry)!
      rows.ga4_page_views_per_visit = { value: most, display: String(most), state: most === 1 ? "pass" : "problem", source: "desktop_test", at, ...(grades.ga4 ? { checkId: grades.ga4.checkId } : {}) }
    }
  }

  // PostHog route.
  if (!source.expect.posthog) rows.posthog_route = unmeasured("desktop_test", "not_connected")
  else if (!dry) rows.posthog_route = unmeasured("desktop_test", "not_exercised")
  else {
    const held = heldOrUnknown("posthog")
    const viaDomain = dry.posthog.events.some((event) => event.sameOrigin)
    const direct = dry.posthog.events.some((event) => !event.sameOrigin)
    if (held && !viaDomain && !direct) rows.posthog_route = held
    else if (direct) rows.posthog_route = { value: "direct", display: "direct to PostHog (ad blockers drop it)", state: "problem", source: "desktop_test", at }
    else if (viaDomain) rows.posthog_route = { value: "proxied", display: "through your domain", state: "pass", source: "desktop_test", at }
    else rows.posthog_route = { value: "not firing", display: "not firing", state: "problem", source: "desktop_test", at }
  }

  // Meta pixel.
  if (!source.expect.meta) rows.meta_pixel = unmeasured("desktop_test", "not_connected")
  else if (!dry || !grades.meta) rows.meta_pixel = unmeasured("desktop_test", "not_exercised")
  else {
    const grade = grades.meta
    const held = heldOrUnknown("meta")
    rows.meta_pixel = held ?? { value: grade.state === "pass" ? "sending" : gradeReasonCode(grade) || grade.state, display: grade.state === "pass" ? "loads (nothing sent)" : gradeWords(grade, host), state: grade.state, source: "desktop_test", at, checkId: grade.checkId }
  }

  // Page views from preview links.
  if (split) {
    const raw = share(split)
    rows.preview_share = { value: raw.numerator, state: raw.numerator > 0 ? "problem" : "pass", source: "cloud_read", at, raw, ...(window ? { window } : {}) }
  } else {
    const bothUnconnected = source.baseline !== null && source.baseline.ga4.status === "not_connected" && source.baseline.posthog.status === "not_connected"
    rows.preview_share = unmeasured("cloud_read", bothUnconnected ? "not_connected" : "read_failed")
  }

  // Conversions sent from the server.
  const outcomes = source.baseline?.serverLane.outcomes7d ?? null
  rows.server_conversions =
    outcomes === null
      ? unmeasured("cloud_read", source.baseline ? "not_connected" : "read_failed")
      : { value: outcomes, display: `${outcomes} in 7 days`, state: outcomes > 0 ? "pass" : "problem", source: "cloud_read", at }

  // GA4 key events.
  const keyEvents = source.baseline?.ga4.keyEvents ?? null
  if (keyEvents === null) rows.ga4_key_events = unmeasured("cloud_read", baselineReason(source.baseline, source.baseline?.ga4.status))
  else {
    const designated = keyEvents.filter((event) => event.designated).length
    rows.ga4_key_events = { value: designated, display: `${designated} marked`, state: designated > 0 ? "pass" : "problem", source: "cloud_read", at, ...(window ? { window } : {}) }
  }

  // Consent setting.
  const consent = source.keys.infinite.consentMode
  rows.consent_setting = consent
    ? { value: consent, display: consentWords(consent), state: "pass", source: "cloud_read", at }
    : { value: "not recorded", display: "not recorded", state: "problem", source: "cloud_read", at }

  // Live test per tool.
  const graded = tools.map((tool) => grades[tool]).filter((grade): grade is CheckResult => grade !== undefined)
  if (graded.length === 0) rows.live_test_per_tool = unmeasured("desktop_test", tools.length === 0 ? "not_connected" : "not_exercised")
  else {
    const pass = graded.filter((grade) => grade.state === "pass").length
    const state: LiveTodayRow["state"] = graded.some((grade) => grade.state === "problem") ? "problem" : graded.some((grade) => grade.state === "undetermined") ? "undetermined" : "pass"
    rows.live_test_per_tool = { value: `${pass}/${graded.length}`, display: `${pass} of ${graded.length} tools fire once (nothing sent)`, state, source: "desktop_test", at }
  }
  return rows
}
