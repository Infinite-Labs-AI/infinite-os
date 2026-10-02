// The rehearsal (lane O4, §3d.1 step 8, §3h): the PR head's Vercel preview loaded UNDER THE PRODUCTION
// HOSTNAME in the desktop's hidden window (`rehearsal` mode: every beacon recorded and cancelled, nothing sent),
// plus a `dry_live` load of the preview's OWN URL (`preview_self`: guarded tools must stay silent there). The
// desktop returns facts; O6's grader (`checks.gradeTestRun`) is the only thing that grades them. The
// click tests feed `clickTestedConversions` and the GA4 key events (non-static frameworks, §3d.1).
//
// Honest states: a protected preview, a non-Vercel host, or no preview within 10 minutes is `undetermined`,
// never pass. Nothing here is computed from agent output.
import type { WizardContext, WizardDeps } from "../wizard/contracts/deps.js"
import type { CheckResult } from "../wizard/contracts/jobs.js"
import type { Cell, CellState, FinishLineId, Reason, ReportColumnSnapshot, ReportRowId } from "../wizard/contracts/report.js"
import { NULL_DISPLAY, REASONS } from "../wizard/contracts/report.js"
import { PR_LOOP_LIMITS } from "../wizard/contracts/git-host.js"
import { normalizeHost } from "../wizard/contracts/host-deny.js"
import {
  TEST_LIMITS,
  testExpectFromKeys,
  testRequestModeErrors,
  type TestExpect,
  type TestMode,
  type TestResult,
  type TestRunRequest,
  type TestTool
} from "../wizard/contracts/test-engine.js"
import type { WizardStepId } from "../wizard/contracts/steps.js"
import { isGitHubAdapter } from "../hosts/github.js"
import { isUnsupported } from "../hosts/other.js"
import type { RunFacts } from "./context.js"
import { sub } from "./context.js"

export type RehearsalUndetermined = "not_vercel" | "preview_protected" | "no_preview" | "no_production_host" | "not_github" | "test_error"

export interface RehearsalOutcome {
  state: "graded" | "undetermined"
  reason: RehearsalUndetermined | null
  previewUrl: string | null
  grades: Partial<Record<TestTool, CheckResult>>
  previewGrades: Partial<Record<TestTool, CheckResult>>
  /** Approved conversions whose click test passed in this rehearsal. */
  clickTested: string[]
  /** The subset whose click fired a GA4 event (only these may become GA4 key events). */
  ga4ClickTested: string[]
  /** Facts read off the rehearsal (not grades): PostHog's beacons went same-origin (the /ingest proxy); CSP violations. */
  facts: { posthogSameOrigin: boolean | null; cspViolations: number | null }
  /** Whether the rehearsal exercised a client-side navigation (the SPA page-view check). */
  spaExercised: boolean
}

const POLL_WAIT_SECONDS = 25
const PREVIEW_POLL_MS = 15_000

/** Whether a normalised host is the production host or a registrable-domain sibling (`www.` and subdomains). */
export function productionMatcher(productionHost: string): (host: string) => boolean {
  const prod = normalizeHost(productionHost).replace(/^www\./, "")
  return (host: string) => {
    const candidate = normalizeHost(host).replace(/^www\./, "")
    return candidate === prod || candidate.endsWith(`.${prod}`) || prod.endsWith(`.${candidate}`)
  }
}

/** The conversion selector the managed helpers render (`data-infinite-conversion="<name>"`). */
export function conversionSelector(name: string): string {
  return `[data-infinite-conversion="${name.replace(/["\\]/g, "")}"]`
}

/** Pages to load: the production root plus up to 4 production URLs the jobs' evidence names (where the conversions live). */
export function rehearsalTargets(productionHost: string, evidenceUrls: readonly string[]): Array<{ url: string; label: string }> {
  const isProd = productionMatcher(productionHost)
  const targets = [{ url: `https://${productionHost}/`, label: "home" }]
  const seen = new Set([targets[0]!.url])
  for (const raw of evidenceUrls) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== "https:" || !isProd(url.hostname)) continue
    const clean = `https://${productionHost}${url.pathname}`
    if (seen.has(clean)) continue
    seen.add(clean)
    targets.push({ url: clean, label: url.pathname.replace(/^\/+/, "").slice(0, 40) || "page" })
    if (targets.length >= TEST_LIMITS.maxTargets) break
  }
  return targets
}

/** Polls a desktop test run to its end (the server holds each poll ≤ 25 s); cancels it on abort. */
export async function runDesktopTest(
  ctx: WizardContext,
  deps: WizardDeps,
  step: WizardStepId,
  request: Omit<TestRunRequest, "protocolVersion" | "requestId">
): Promise<{ result: TestResult | null; error: string | null }> {
  const started = await deps.bridge.startTest(request)
  const deadline = deps.clock.now().getTime() + request.deadlineMs + 30_000
  for (;;) {
    if (ctx.signal.aborted) {
      await deps.bridge.cancelTest(started.testRunId).catch(() => undefined)
      return { result: null, error: "cancelled" }
    }
    const poll = await deps.bridge.pollTest(started.testRunId, POLL_WAIT_SECONDS)
    for (const beat of poll.progress.slice(-1)) if (beat.text) sub(ctx, step, beat.text.slice(0, 120), "pending")
    if (poll.state === "done") return poll.result ? { result: poll.result, error: null } : { result: null, error: "no result" }
    if (poll.state === "failed" || poll.state === "cancelled") return { result: null, error: poll.error?.message ?? poll.state }
    if (deps.clock.now().getTime() > deadline) {
      await deps.bridge.cancelTest(started.testRunId).catch(() => undefined)
      return { result: null, error: "deadline" }
    }
    // The desktop holds each poll up to 25 s; a quick "running" answer never turns this into a hot loop.
    await deps.clock.sleep(1_000, ctx.signal)
  }
}

async function waitForPreview(ctx: WizardContext, deps: WizardDeps, step: WizardStepId, head: string): Promise<string | null> {
  const until = deps.clock.now().getTime() + PR_LOOP_LIMITS.previewWaitMs
  sub(ctx, step, "Waiting for its Vercel preview…", "pending")
  for (;;) {
    // A failed read (rate limit, a blip) is "not yet", never a guess.
    const url = await deps.host.previewUrl(head).catch(() => null)
    if (isUnsupported(url)) return null
    if (url) return url
    if (ctx.signal.aborted || deps.clock.now().getTime() + PREVIEW_POLL_MS > until) return null
    await deps.clock.sleep(PREVIEW_POLL_MS, ctx.signal)
  }
}

function clickResults(result: TestResult, names: readonly string[]): { tested: string[]; ga4: string[] } {
  const tested: string[] = []
  const ga4: string[] = []
  for (const name of names) {
    const click = result.clicks.find((candidate) => candidate.label === name)
    if (!click || !click.found) continue
    // A standard Meta conversion fired by a click is on the never-list: such a click never counts as passed.
    if (click.events.meta.length > 0) continue
    const fired = click.events.ga4.includes(name) || click.events.posthog.includes(name) || click.events.infinite.includes(name)
    if (!fired) continue
    tested.push(name)
    if (click.events.ga4.includes(name)) ga4.push(name)
  }
  return { tested, ga4 }
}

/** Runs the rehearsal on `head`. Never throws for a site problem: those are graded `problem`. */
export async function rehearse(
  ctx: WizardContext,
  deps: WizardDeps,
  input: { step: WizardStepId; runId: string; head: string; facts: RunFacts; approvedConversions: readonly string[]; evidenceUrls: readonly string[]; consentRequired: boolean }
): Promise<RehearsalOutcome> {
  const empty = (reason: RehearsalUndetermined, previewUrl: string | null = null): RehearsalOutcome => ({
    state: "undetermined",
    reason,
    previewUrl,
    grades: {},
    previewGrades: {},
    clickTested: [],
    ga4ClickTested: [],
    facts: { posthogSameOrigin: null, cspViolations: null },
    spaExercised: false
  })
  const { facts } = input
  if (!facts.hosting || facts.hosting.provider !== "vercel" || !facts.hosting.vercel) return empty("not_vercel")
  if (facts.hosting.vercel.previewProtection !== "none" && facts.hosting.vercel.previewProtection !== "unknown") return empty("preview_protected")
  if (!facts.productionHost) return empty("no_production_host")
  if (deps.host.kind !== "github") return empty("not_github")
  if (isGitHubAdapter(deps.host)) deps.host.setPreviewProject(facts.hosting.vercel.projectName)
  const previewUrl = await waitForPreview(ctx, deps, input.step, input.head)
  if (!previewUrl) return empty("no_preview")

  const expect: TestExpect = facts.keys ? testExpectFromKeys(facts.keys) : {}
  const consentSeed =
    input.consentRequired && facts.keys?.infinite.consentStorageKey
      ? { kind: "infinite_runtime_grant" as const, storageKey: facts.keys.infinite.consentStorageKey }
      : null
  const targets = rehearsalTargets(facts.productionHost, input.evidenceUrls)
  const secondPath = targets[1] ? new URL(targets[1].url).pathname : null
  const previewOrigin = new URL(previewUrl).origin
  const rehearsalRequest: Omit<TestRunRequest, "protocolVersion" | "requestId"> = {
    mode: "rehearsal",
    runId: input.runId,
    productionHost: facts.productionHost,
    targets,
    rehearsal: { previewOrigin, headSha: input.head },
    expect,
    fakeClickId: true,
    consentSeed,
    clicks: input.approvedConversions.map((name) => ({ selector: conversionSelector(name), label: name })),
    ...(secondPath ? { spaNavigation: { path: secondPath } } : {}),
    deadlineMs: TEST_LIMITS.deadlineMs.rehearsal
  }
  const previewRequest: Omit<TestRunRequest, "protocolVersion" | "requestId"> = {
    mode: "dry_live",
    runId: input.runId,
    productionHost: facts.productionHost,
    targets: [{ url: `${previewOrigin}/`, label: "preview_self" }],
    expect,
    consentSeed,
    deadlineMs: TEST_LIMITS.deadlineMs.dry_live
  }
  const isProd = productionMatcher(facts.productionHost)
  for (const request of [rehearsalRequest, previewRequest]) {
    const errors = testRequestModeErrors({ protocolVersion: 1, requestId: "check", ...request }, isProd)
    if (errors.length > 0) throw new Error(`rehearsal request refused before sending: ${errors.join("; ")}`)
  }

  sub(ctx, input.step, `Loading the preview under ${facts.productionHost} (nothing sent)…`, "pending")
  const rehearsal = await runDesktopTest(ctx, deps, input.step, rehearsalRequest)
  const preview = await runDesktopTest(ctx, deps, input.step, previewRequest)
  if (!rehearsal.result) return empty("test_error", previewUrl)

  const census = await deps.checks.census(ctx.root, ctx.appRoot)
  const grade = (result: TestResult, mode: TestMode) =>
    deps.checks.gradeTestRun(result, expect, mode, { cmpDetected: result.environment.cmpDetected, envSourcedIds: census.envSourcedIds })
  const grades = await grade(rehearsal.result, "rehearsal")
  const previewGrades = preview.result ? await grade(preview.result, "dry_live") : {}
  const clicks = clickResults(rehearsal.result, input.approvedConversions)
  ctx.state.update((state) => {
    state.markers.rehearsal = { ...rehearsal.result!.markers }
  })
  const posthogEvents = rehearsal.result.posthog.events
  return {
    state: "graded",
    reason: null,
    previewUrl,
    grades,
    previewGrades,
    clickTested: clicks.tested,
    ga4ClickTested: clicks.ga4,
    facts: {
      posthogSameOrigin: posthogEvents.length === 0 ? null : posthogEvents.every((event) => event.sameOrigin),
      cspViolations: rehearsal.result.csp.violations.length
    },
    spaExercised: secondPath !== null
  }
}

// ---------------------------------------------------------------------------------------------
// The `in_pr` report cells the rehearsal measures (§3i.7: provenance `desktop_test`, this run, this head)
// ---------------------------------------------------------------------------------------------

const TOOL_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta" }

function asReason(value: string | undefined | null): Reason | undefined {
  return value && (REASONS as readonly string[]).includes(value) ? (value as Reason) : undefined
}

function makeCell(state: CellState, value: string | null, display: string, at: string, runId: string, reason?: Reason, checkId?: string): Cell {
  const cell: Cell = {
    value,
    display: value === null ? NULL_DISPLAY : display,
    state,
    provenance: { source: "desktop_test", at, runId, ...(checkId ? { checkId } : {}) }
  }
  if (reason) cell.reason = reason
  return cell
}

function combine(results: readonly CheckResult[], problemWhen: (result: CheckResult) => boolean): CellState {
  if (results.some(problemWhen)) return "problem"
  if (results.some((result) => result.state === "pass")) return "pass"
  return "undetermined"
}

const UNDETERMINED_REASON: Record<RehearsalUndetermined, Reason> = {
  not_vercel: "not_vercel",
  preview_protected: "preview_protected",
  no_preview: "not_exercised",
  no_production_host: "not_exercised",
  not_github: "not_exercised",
  test_error: "not_exercised"
}

/** Writes the rehearsal's `in_pr` cells for `head` (only the cells the rehearsal measures; other lanes keep theirs). */
export function rehearsalCells(outcome: RehearsalOutcome, input: { head: string; at: string; runId: string }): Pick<ReportColumnSnapshot, "cells" | "finishLine"> {
  const { at, runId } = input
  const finishLine: Partial<Record<FinishLineId, Cell>> = {}
  const cells: Partial<Record<ReportRowId, Cell>> = {}
  const ids: FinishLineId[] = ["each_tool_once", "ids_match_connections", "previews_silent", "survives_ad_blockers", "spa_page_views", "csp_allows", "no_pii"]
  if (outcome.state === "undetermined") {
    const reason = UNDETERMINED_REASON[outcome.reason ?? "test_error"]
    for (const id of ids) finishLine[id] = makeCell("undetermined", null, NULL_DISPLAY, at, runId, reason)
    return { cells, finishLine }
  }
  const graded = Object.values(outcome.grades).filter((result): result is CheckResult => Boolean(result))
  const preview = Object.values(outcome.previewGrades).filter((result): result is CheckResult => Boolean(result))
  const problem = (codes: readonly string[]) => (result: CheckResult) => result.state === "problem" && codes.includes(result.reason ?? "")
  const once = combine(graded, problem(["duplicate_page_view", "no_beacon"]))
  finishLine.each_tool_once = makeCell(once, once === "undetermined" ? null : once, once === "pass" ? "each tool once" : "a tool fires twice or not at all", at, runId, undefined, "one_beacon_per_tool")
  const idsState = combine(graded, problem(["wrong_id"]))
  finishLine.ids_match_connections = makeCell(idsState, idsState === "undetermined" ? null : idsState, idsState === "pass" ? "right IDs" : "an ID differs from the connection", at, runId)
  const previewState = preview.some((result) => result.reason === "previews_send_data") ? "problem" : preview.length > 0 ? "pass" : "undetermined"
  finishLine.previews_silent = makeCell(previewState, previewState === "undetermined" ? null : previewState, previewState === "pass" ? "preview link sent nothing" : "the preview link sends data", at, runId, previewState === "undetermined" ? "not_exercised" : undefined, "preview_self_silent")
  // RH posthog_via_proxy_once: PostHog graded "fires once, right key" AND its beacons went same-origin.
  const posthog = outcome.grades.posthog
  if (!posthog || posthog.state === "undetermined" || outcome.facts.posthogSameOrigin === null) {
    finishLine.survives_ad_blockers = makeCell("undetermined", null, NULL_DISPLAY, at, runId, asReason(posthog?.reason) ?? "not_connected", "posthog_via_proxy_once")
  } else if (posthog.state === "pass" && outcome.facts.posthogSameOrigin) {
    finishLine.survives_ad_blockers = makeCell("pass", "pass", "PostHog through /ingest, once", at, runId, undefined, "posthog_via_proxy_once")
  } else if (posthog.state === "pass") {
    finishLine.survives_ad_blockers = makeCell("info", "direct", "PostHog sends direct (no /ingest proxy)", at, runId, undefined, "posthog_via_proxy_once")
  } else {
    finishLine.survives_ad_blockers = makeCell("problem", "problem", `PostHog: ${posthog.reason ?? "problem"}`, at, runId, undefined, "posthog_via_proxy_once")
  }
  if (outcome.spaExercised) {
    const spa = combine(graded, problem(["duplicate_page_view"]))
    finishLine.spa_page_views = makeCell(spa, spa === "undetermined" ? null : spa, spa === "pass" ? "one page view per navigation" : "a navigation counts twice", at, runId)
  } else {
    finishLine.spa_page_views = makeCell("not_measured", null, NULL_DISPLAY, at, runId, "not_exercised")
  }
  // RH no_csp_violation: the count of violations the test window recorded (a fact, zero = pass).
  const violations = outcome.facts.cspViolations
  finishLine.csp_allows =
    violations === null
      ? makeCell("undetermined", null, NULL_DISPLAY, at, runId, "not_exercised", "no_csp_violation")
      : makeCell(violations === 0 ? "pass" : "problem", String(violations), violations === 0 ? "no CSP violation" : `${violations} CSP violation(s)`, at, runId, undefined, "no_csp_violation")
  const pii = combine(graded, problem(["no_pii"]))
  finishLine.no_pii = makeCell(pii, pii === "undetermined" ? null : pii, pii === "pass" ? "no personal data in beacons" : "personal data in a beacon", at, runId)
  const row = (tool: TestTool): Cell => {
    const result = outcome.grades[tool]
    if (!result) return makeCell("undetermined", null, NULL_DISPLAY, at, runId, "not_connected")
    const reason = asReason(result.reason)
    if (result.state === "undetermined") return makeCell("undetermined", null, NULL_DISPLAY, at, runId, reason)
    return makeCell(result.state, result.state, result.state === "pass" ? `${TOOL_LABEL[tool]}: fires once, right ID` : `${TOOL_LABEL[tool]}: ${result.reason ?? "problem"}`, at, runId, reason, result.checkId)
  }
  cells.ga4_page_views_per_visit = row("ga4")
  cells.posthog_route = row("posthog")
  cells.meta_pixel = row("meta")
  return { cells, finishLine }
}

/** Merges the rehearsal's cells into the run state's `in_pr` column for `head`. */
export function recordRehearsalCells(ctx: WizardContext, outcome: RehearsalOutcome, input: { head: string; runId: string }): void {
  const at = ctx.now().toISOString()
  const fresh = rehearsalCells(outcome, { ...input, at })
  ctx.state.update((state) => {
    const previous = state.report.in_pr
    // §3i.3 rule 7: in_pr cells are keyed to the head; a new head starts a new column.
    const base = previous && previous.meta.sha === input.head ? previous : { meta: { measuredAt: at, sha: input.head }, cells: {}, finishLine: {} }
    state.report.in_pr = {
      meta: { measuredAt: at, sha: input.head },
      cells: { ...base.cells, ...fresh.cells },
      finishLine: { ...base.finishLine, ...fresh.finishLine }
    }
  })
}

/** One line per tool, the design's rehearsal sub-statuses. */
export function rehearsalLines(outcome: RehearsalOutcome): Array<{ text: string; tone: "ok" | "warn" | "info" }> {
  if (outcome.state === "undetermined") {
    const why: Record<RehearsalUndetermined, string> = {
      not_vercel: "Rehearsal: undetermined (the site is not on Vercel)",
      preview_protected: "Rehearsal: undetermined (the preview is protected)",
      no_preview: "Rehearsal: undetermined (no preview appeared within 10 minutes)",
      no_production_host: "Rehearsal: undetermined (no production host known)",
      not_github: "Rehearsal: undetermined (previews are read from GitHub only)",
      test_error: "Rehearsal: undetermined (the test window did not finish)"
    }
    return [{ text: why[outcome.reason ?? "test_error"], tone: "warn" }]
  }
  const lines: Array<{ text: string; tone: "ok" | "warn" | "info" }> = []
  for (const tool of ["ga4", "posthog", "meta", "infinite"] as const) {
    const result = outcome.grades[tool]
    if (!result) continue
    if (result.state === "pass") lines.push({ text: `✓ ${TOOL_LABEL[tool]} fires once · right ID`, tone: "ok" })
    else if (result.state === "problem") lines.push({ text: `${TOOL_LABEL[tool]}: ${result.reason ?? "problem"}`, tone: "warn" })
    else lines.push({ text: `${TOOL_LABEL[tool]}: undetermined (${result.reason ?? "unknown"})`, tone: "info" })
  }
  if (outcome.clickTested.length > 0) lines.push({ text: `✓ Conversions fire on the right buttons (${outcome.clickTested.length})`, tone: "ok" })
  const preview = Object.values(outcome.previewGrades)
  if (preview.some((result) => result?.reason === "previews_send_data")) lines.push({ text: "The preview link itself sends data", tone: "warn" })
  else if (preview.length > 0) lines.push({ text: "✓ Preview links themselves send nothing", tone: "ok" })
  return lines
}
