// The rehearsal (lane O4, §3d.1 step 8, §3h): the PR head's Vercel preview loaded UNDER THE PRODUCTION
// HOSTNAME in the desktop's hidden window (`rehearsal` mode: every beacon recorded and cancelled, nothing sent),
// plus a `dry_live` load of the preview's OWN URL (`preview_self`: guarded tools must stay silent there). The
// desktop returns facts; O6's grader (`checks.gradeTestRun`) is the only thing that grades them. The
// click tests feed `clickTestedConversions` and the GA4 key events (non-static frameworks, §3d.1).
//
// Honest states: a protected preview, a non-Vercel host, or no preview within 10 minutes is `undetermined`,
// never pass. Nothing here is computed from agent output.
import { gradeContextFrom } from "../checks/grade-context.js"
import type { WizardContext, WizardDeps } from "../wizard/contracts/deps.js"
import type { ChecklistItem, CheckResult } from "../wizard/contracts/jobs.js"
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
import { GhError } from "../github/gh.js"
import { isGitHubAdapter } from "../hosts/github.js"
import { isUnsupported } from "../hosts/other.js"
import { checksPassingCell } from "../wizard/report.js"
import type { TagKeys } from "../wizard/contracts/bridge.js"
import type { RunFacts } from "./context.js"
import { derivedInPrCells, ga4KeyEventCells, preMergeCells } from "./in-pr-cells.js"
import { bridgeErrorCode, bridgeStopCode, sub } from "./context.js"

export type RehearsalUndetermined =
  | "not_vercel"
  | "preview_protected"
  | "no_preview"
  | "no_production_host"
  | "not_github"
  | "gh_unavailable"
  | "test_error"
  | "test_busy"
  | "facts_unreadable"

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
  /** Facts read off the rehearsal (not grades): PostHog's beacons went same-origin (the /ingest proxy); CSP violations
   *  that blocked an analytics host, and the other (unrelated) violations. */
  facts: {
    posthogSameOrigin: boolean | null
    cspViolations: number | null
    cspOtherViolations?: number
    /** GA4 page views on one page load (the most over the loads; a navigation's own page view is not counted): the
     *  rehearsal's beacons, recorded and cancelled. Null when no GA4 beacon was seen. */
    ga4PageViewsPerLoad?: number | null
  }
  /** The tools the connections expect (from the keys) and the tools the census found in the PR's tree. A cell is
   *  `pass` only when every one of these graded pass; one undetermined tool makes it undetermined. */
  expectedTools?: TestTool[]
  installedTools?: TestTool[]
  /** Whether the rehearsal exercised a client-side navigation (the SPA page-view check). */
  spaExercised: boolean
  /** Per approved conversion: the click test's verdict (pass, problem, or undetermined when no element matched). */
  clickVerdicts?: Array<[string, { state: "pass" | "problem" | "undetermined"; reason?: string }]>
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
  try {
    return await pollDesktopTest(ctx, deps, step, request)
  } catch (error) {
    // 402 / signed out stop the step; a busy window, a timeout or a cloud error make the test undetermined.
    if (bridgeStopCode(error) !== null) throw error
    const code = bridgeErrorCode(error)
    if (code === null) throw error
    return { result: null, error: code }
  }
}

async function pollDesktopTest(
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

async function waitForPreview(ctx: WizardContext, deps: WizardDeps, step: WizardStepId, head: string): Promise<{ url: string } | { url: null; why: "no_preview" | "gh_unavailable" }> {
  const until = deps.clock.now().getTime() + PR_LOOP_LIMITS.previewWaitMs
  sub(ctx, step, "Waiting for its Vercel preview…", "pending")
  for (;;) {
    let url: Awaited<ReturnType<WizardDeps["host"]["previewUrl"]>> | null
    try {
      url = await deps.host.previewUrl(head)
    } catch (error) {
      // gh missing or logged out never recovers by waiting; a rate limit or a blip is "not yet", never a guess.
      if (error instanceof GhError && (error.kind === "not_installed" || error.kind === "not_authenticated")) return { url: null, why: "gh_unavailable" }
      url = null
    }
    if (isUnsupported(url)) return { url: null, why: "no_preview" }
    if (url) return { url }
    if (ctx.signal.aborted || deps.clock.now().getTime() + PREVIEW_POLL_MS > until) return { url: null, why: "no_preview" }
    await deps.clock.sleep(PREVIEW_POLL_MS, ctx.signal)
  }
}

function clickResults(result: TestResult, names: readonly string[]): { tested: string[]; ga4: string[]; verdicts: NonNullable<RehearsalOutcome["clickVerdicts"]> } {
  const tested: string[] = []
  const ga4: string[] = []
  const verdicts: NonNullable<RehearsalOutcome["clickVerdicts"]> = []
  for (const name of names) {
    const click = result.clicks.find((candidate) => candidate.label === name)
    if (!click || !click.found) {
      verdicts.push([name, { state: "undetermined", reason: "not_exercised" }])
      continue
    }
    // A standard Meta conversion fired by a click is on the never-list: such a click never counts as passed.
    if (click.events.meta.length > 0) {
      verdicts.push([name, { state: "problem", reason: `fbq_standard_on_click — ${click.events.meta.join(", ")}` }])
      continue
    }
    const fired = click.events.ga4.includes(name) || click.events.posthog.includes(name) || click.events.infinite.includes(name)
    if (!fired) {
      verdicts.push([name, { state: "problem", reason: `click_test — the click did not send ${name}` }])
      continue
    }
    verdicts.push([name, { state: "pass" }])
    tested.push(name)
    if (click.events.ga4.includes(name)) ga4.push(name)
  }
  return { tested, ga4, verdicts }
}

/** Runs the rehearsal on `head`. Never throws for a site problem: those are graded `problem`. */
export async function rehearse(
  ctx: WizardContext,
  deps: WizardDeps,
  input: {
    step: WizardStepId
    runId: string
    head: string
    facts: RunFacts
    approvedConversions: readonly string[]
    evidenceUrls: readonly string[]
    consentRequired: boolean
    /** gh is installed and logged in (previews are read through it). */
    ghReady: boolean
  }
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
    spaExercised: false,
    expectedTools: [],
    installedTools: []
  })
  const { facts } = input
  if (facts.readFailed) return empty("facts_unreadable")
  // §3y.4: Infinite hosting on Vercel, a local `.vercel/` link, or a `vercel[bot]` deployment (the signal). Without
  // Infinite's connection the preview's protection is unknown: the rehearsal still runs, and D2's
  // `environment.previewProtected` grades a protected preview `undetermined`, never a pass.
  const vercelHosting = facts.hosting?.provider === "vercel" && facts.hosting.vercel ? facts.hosting.vercel : null
  if (!vercelHosting && facts.vercelSignal !== true) return empty("not_vercel")
  if (vercelHosting && vercelHosting.previewProtection !== "none" && vercelHosting.previewProtection !== "unknown") return empty("preview_protected")
  if (!facts.productionHost) return empty("no_production_host")
  if (deps.host.kind !== "github") return empty("not_github")
  if (!input.ghReady) return empty("gh_unavailable")
  if (isGitHubAdapter(deps.host)) deps.host.setPreviewProject(vercelHosting?.projectName ?? facts.vercelProject ?? null)
  const waited = await waitForPreview(ctx, deps, input.step, input.head)
  if (waited.url === null) return empty(waited.why)
  const previewUrl = waited.url

  const expect: TestExpect = facts.keys ? testExpectFromKeys(facts.keys, facts.claim ?? null) : {}
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
  if (!rehearsal.result) return empty(rehearsal.error === "busy" ? "test_busy" : "test_error", previewUrl)

  const census = await deps.checks.census(ctx.root, ctx.appRoot)
  // §3z.12 §3e.7 (B11): the grader always gets the site's consent mode, the installed tools and whose Meta pixel it is.
  const gradeCtx = gradeContextFrom({ census, consentMode: input.consentRequired ? "required" : "not_required", cmpDetected: null })
  const grade = (result: TestResult, mode: TestMode) => deps.checks.gradeTestRun(result, expect, mode, { ...gradeCtx, cmpDetected: result.environment.cmpDetected })
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
    clickVerdicts: clicks.verdicts,
    facts: {
      posthogSameOrigin: posthogEvents.length === 0 ? null : posthogEvents.every((event) => event.sameOrigin),
      ga4PageViewsPerLoad: ga4PageViewsPerLoad(rehearsal.result),
      ...cspCounts(rehearsal.result.csp.violations, expect)
    },
    spaExercised: secondPath !== null,
    expectedTools: expectedToolsOf(expect),
    installedTools: [...(gradeCtx.installedTools ?? [])]
  }
}

/** The most GA4 page views one page load sent (the same count the "Live site today" column shows); null = no GA4 beacon. */
export function ga4PageViewsPerLoad(result: TestResult): number | null {
  if (result.ga4.events.length === 0) return null
  const perLoad = new Map<string, number>()
  for (const event of result.ga4.events) if (event.en === "page_view" && !event.afterNav) perLoad.set(event.loadLabel, (perLoad.get(event.loadLabel) ?? 0) + 1)
  return Math.max(0, ...perLoad.values())
}

/** The tools a `TestExpect` names (the connected ones). */
export function expectedToolsOf(expect: TestExpect): TestTool[] {
  return (["infinite", "ga4", "posthog", "meta"] as const).filter((tool) => expect[tool] !== undefined)
}

const ANALYTICS_HOST_SUFFIXES = ["google-analytics.com", "analytics.google.com", "googletagmanager.com", "posthog.com", "facebook.com", "facebook.net"]

function hostOf(value: string): string {
  try {
    return normalizeHost(value.includes("://") ? new URL(value).hostname : value.split("/")[0]!)
  } catch {
    return normalizeHost(value)
  }
}

/**
 * CSP violations split into those that blocked an analytics host (GA4, PostHog incl. its connected api host, Meta)
 * and the rest. A site's unrelated violation (a blocked font) says nothing about whether the CSP allows analytics.
 */
export function cspCounts(violations: ReadonlyArray<{ blockedHost: string }>, expect: TestExpect): { cspViolations: number; cspOtherViolations: number } {
  const suffixes = [...ANALYTICS_HOST_SUFFIXES]
  if (expect.posthog?.apiHost) suffixes.push(hostOf(expect.posthog.apiHost))
  const analytics = violations.filter((violation) => {
    const host = hostOf(violation.blockedHost)
    return host.length > 0 && suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
  }).length
  return { cspViolations: analytics, cspOtherViolations: violations.length - analytics }
}

// ---------------------------------------------------------------------------------------------
// The `in_pr` report cells the rehearsal measures (§3i.7: provenance `desktop_test`, this run, this head)
// ---------------------------------------------------------------------------------------------

const TOOL_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta" }
const TOOLS: readonly TestTool[] = ["infinite", "ga4", "posthog", "meta"]
/** The tools O6 guards on previews (they must stay silent on the preview's own URL). */
const GUARDED: readonly TestTool[] = ["ga4", "posthog", "meta"]

/**
 * The code of a graded result. O6's grader writes `reason` as `<code> — <detail>`; a bare code (or a detail with
 * no code) is returned whole.
 */
export function reasonCode(result: Pick<CheckResult, "reason"> | undefined | null): string {
  return (result?.reason ?? "").split(" — ")[0]!.trim()
}

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

type Grades = Partial<Record<TestTool, CheckResult>>

/**
 * The tools a cell must account for: every connected (expected) tool, every tool the census found in the PR's tree,
 * and every tool that actually fired (graded pass or problem). A tool that is neither connected nor installed and
 * sent nothing (`info`, not installed) is left out.
 */
function consideredTools(outcome: RehearsalOutcome, grades: Grades, among: readonly TestTool[] = TOOLS): TestTool[] {
  const named = new Set([...(outcome.expectedTools ?? []), ...(outcome.installedTools ?? [])])
  return among.filter((tool) => named.has(tool) || grades[tool]?.state === "pass" || grades[tool]?.state === "problem")
}

/**
 * One finish-line cell from O6's per-tool grades (§0 "undetermined never counts as pass"):
 * - `problem` when ANY graded tool has one of `codes`;
 * - `pass` only when EVERY considered tool graded pass;
 * - `undetermined` otherwise (a tool undetermined, missing, or failing something this cell cannot see past).
 */
function aggregate(outcome: RehearsalOutcome, grades: Grades, codes: readonly string[], among: readonly TestTool[] = TOOLS): { state: CellState; reason?: Reason } {
  const graded = among.map((tool) => grades[tool]).filter((result): result is CheckResult => Boolean(result))
  if (graded.some((result) => result.state === "problem" && codes.includes(reasonCode(result)))) return { state: "problem" }
  const tools = consideredTools(outcome, grades, among)
  if (tools.length > 0 && tools.every((tool) => grades[tool]?.state === "pass")) return { state: "pass" }
  const blocking = tools.map((tool) => grades[tool]).find((result) => !result || result.state !== "pass")
  return { state: "undetermined", reason: asReason(reasonCode(blocking)) ?? (tools.length === 0 ? "not_connected" : "not_exercised") }
}

function finishCell(verdict: { state: CellState; reason?: Reason }, text: { pass: string; problem: string }, at: string, runId: string, checkId?: string): Cell {
  if (verdict.state === "undetermined") return makeCell("undetermined", null, NULL_DISPLAY, at, runId, verdict.reason ?? "not_exercised", checkId)
  return makeCell(verdict.state, verdict.state, verdict.state === "pass" ? text.pass : text.problem, at, runId, undefined, checkId)
}

const UNDETERMINED_REASON: Record<RehearsalUndetermined, Reason> = {
  not_vercel: "not_vercel",
  preview_protected: "preview_protected",
  no_preview: "not_exercised",
  no_production_host: "not_exercised",
  not_github: "not_exercised",
  gh_unavailable: "read_failed",
  test_error: "not_exercised",
  test_busy: "not_exercised",
  facts_unreadable: "read_failed"
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
  const grades = outcome.grades
  finishLine.each_tool_once = finishCell(
    aggregate(outcome, grades, ["duplicate_page_view", "no_beacon"]),
    { pass: "each tool once", problem: "a tool fires twice or not at all" },
    at,
    runId,
    "one_beacon_per_tool"
  )
  finishLine.ids_match_connections = finishCell(aggregate(outcome, grades, ["wrong_id"]), { pass: "right IDs", problem: "an ID differs from the connection" }, at, runId)
  const preview = outcome.previewGrades
  finishLine.previews_silent =
    Object.keys(preview).length === 0
      ? makeCell("undetermined", null, NULL_DISPLAY, at, runId, "not_exercised", "preview_self_silent")
      : finishCell(aggregate(outcome, preview, ["previews_send_data"], GUARDED), { pass: "preview link sent nothing", problem: "the preview link sends data" }, at, runId, "preview_self_silent")
  // RH posthog_via_proxy_once: PostHog graded "fires once, right key" AND its beacons went same-origin.
  const posthog = grades.posthog
  if (!posthog || (posthog.state !== "pass" && posthog.state !== "problem") || outcome.facts.posthogSameOrigin === null) {
    finishLine.survives_ad_blockers = makeCell("undetermined", null, NULL_DISPLAY, at, runId, asReason(reasonCode(posthog)) ?? (posthog?.state === "info" ? "not_connected" : "not_exercised"), "posthog_via_proxy_once")
  } else if (posthog.state === "pass" && outcome.facts.posthogSameOrigin) {
    finishLine.survives_ad_blockers = makeCell("pass", "pass", "PostHog through /ingest, once", at, runId, undefined, "posthog_via_proxy_once")
  } else if (posthog.state === "pass") {
    finishLine.survives_ad_blockers = makeCell("info", "direct", "PostHog sends direct (no /ingest proxy)", at, runId, undefined, "posthog_via_proxy_once")
  } else {
    finishLine.survives_ad_blockers = makeCell("problem", "problem", `PostHog: ${reasonCode(posthog).replace(/_/g, " ") || "problem"}`, at, runId, undefined, "posthog_via_proxy_once")
  }
  if (outcome.spaExercised) {
    finishLine.spa_page_views = finishCell(
      aggregate(outcome, grades, ["duplicate_page_view"], ["ga4", "posthog"]),
      { pass: "one page view per navigation", problem: "a navigation counts twice" },
      at,
      runId
    )
  } else {
    finishLine.spa_page_views = makeCell("not_measured", null, NULL_DISPLAY, at, runId, "not_exercised")
  }
  // RH no_csp_violation: only violations that blocked an analytics host count (zero = pass).
  const violations = outcome.facts.cspViolations
  const other = outcome.facts.cspOtherViolations ?? 0
  finishLine.csp_allows =
    violations === null
      ? makeCell("undetermined", null, NULL_DISPLAY, at, runId, "not_exercised", "no_csp_violation")
      : makeCell(
          violations === 0 ? "pass" : "problem",
          String(violations),
          violations === 0 ? (other > 0 ? `no CSP violation for analytics (${other} unrelated)` : "no CSP violation") : `${violations} CSP violation(s) block analytics`,
          at,
          runId,
          undefined,
          "no_csp_violation"
        )
  finishLine.no_pii = finishCell(aggregate(outcome, grades, ["no_pii"]), { pass: "no personal data in beacons", problem: "personal data in a beacon" }, at, runId)
  const row = (tool: TestTool): Cell => {
    const result = grades[tool]
    if (!result) return makeCell("undetermined", null, NULL_DISPLAY, at, runId, "not_connected")
    const code = reasonCode(result)
    const reason = asReason(code)
    if (result.state === "undetermined") return makeCell("undetermined", null, NULL_DISPLAY, at, runId, reason ?? "not_exercised")
    return makeCell(
      result.state,
      result.state,
      // The row's label names the tool ("Meta pixel"), so the cell does not say it again.
      result.state === "pass" ? "fires once, right ID (nothing sent)" : code.replace(/_/g, " ") || result.state,
      at,
      runId,
      reason,
      result.checkId
    )
  }
  // The rows say what the row's label asks, in the words of the other two columns ("2" today, "1" in this pull
  // request), from the rehearsal's own beacons. The grader's verdict is the state; a problem it found is named.
  const words = (tool: TestTool) => reasonCode(grades[tool]).replace(/_/g, " ")
  const measured = (tool: TestTool) => grades[tool]?.state === "pass" || grades[tool]?.state === "problem"
  const views = outcome.facts.ga4PageViewsPerLoad
  cells.ga4_page_views_per_visit =
    measured("ga4") && typeof views === "number"
      ? makeCell(grades.ga4!.state, String(views), `${views}${grades.ga4!.state === "problem" && views === 1 && words("ga4") ? ` · ${words("ga4")}` : ""}`, at, runId, undefined, grades.ga4!.checkId)
      : row("ga4")
  const sameOrigin = outcome.facts.posthogSameOrigin
  cells.posthog_route =
    measured("posthog") && sameOrigin === true
      ? makeCell(grades.posthog!.state, "ingest", `through /ingest${grades.posthog!.state === "problem" && words("posthog") ? ` · ${words("posthog")}` : ""}`, at, runId, undefined, "posthog_via_proxy_once")
      : measured("posthog") && sameOrigin === false
        ? makeCell("problem", "direct", "direct to PostHog (ad blockers drop it)", at, runId, undefined, "posthog_via_proxy_once")
        : row("posthog")
  cells.meta_pixel = row("meta")
  // "Live test per tool": before the merge the live test is the rehearsal (every beacon recorded and cancelled).
  const tested = consideredTools(outcome, grades).filter((tool) => grades[tool] && grades[tool]!.state !== "info")
  if (tested.length > 0) {
    const passing = tested.filter((tool) => grades[tool]!.state === "pass").length
    const state: CellState = tested.some((tool) => grades[tool]!.state === "problem") ? "problem" : passing === tested.length ? "pass" : "undetermined"
    cells.live_test_per_tool = makeCell(state, `${passing}/${tested.length}`, `rehearsal: ${passing} of ${tested.length} tools fire once, right ID (nothing sent)`, at, runId)
  }
  return { cells, finishLine }
}

/**
 * The rehearsal's per-check results for the checklist items (RH tier, this run): the finish-line cells that name a
 * check id, plus one `click_test` per conversion item (matched by the conversion name after `conversions_to_tools:`).
 * Built from O6's grades and the click facts; nothing here is the agent's word.
 */
export function rehearsalCheckResults(outcome: RehearsalOutcome, input: { at: string; runId: string }): { shared: CheckResult[]; clicks: Map<string, CheckResult> } {
  const shared: CheckResult[] = []
  const clicks = new Map<string, CheckResult>()
  if (outcome.state === "undetermined") return { shared, clicks }
  const { finishLine } = rehearsalCells(outcome, { head: "", at: input.at, runId: input.runId })
  for (const cell of Object.values(finishLine)) {
    const checkId = cell?.provenance.checkId
    if (!cell || !checkId || (cell.state !== "pass" && cell.state !== "problem" && cell.state !== "undetermined")) continue
    shared.push({ checkId, tier: "RH", state: cell.state, ...(cell.reason ? { reason: cell.reason } : cell.state === "problem" ? { reason: cell.display } : {}), at: input.at, runId: input.runId })
  }
  // The per-tool RH checks of jobs 4 and 5, straight from O6's grade of that tool (an `info` grade, a tool neither
  // connected nor installed, gives no result). GA4's "one page view" is a problem only for a duplicate or a silent
  // tag; any other GA4 problem leaves it undetermined.
  const perTool: Array<[TestTool, string, readonly string[] | null]> = [
    ["ga4", "ga4_one_page_view", ["duplicate_page_view", "no_beacon"]],
    ["meta", "meta_pixel_once", null]
  ]
  for (const [tool, checkId, problemCodes] of perTool) {
    const grade = outcome.grades[tool]
    if (!grade || (grade.state !== "pass" && grade.state !== "problem" && grade.state !== "undetermined")) continue
    const state = grade.state === "problem" && problemCodes !== null && !problemCodes.includes(reasonCode(grade)) ? "undetermined" : grade.state
    shared.push({ checkId, tier: "RH", state, ...(grade.reason ? { reason: grade.reason } : {}), at: input.at, runId: input.runId })
  }
  for (const [name, verdict] of outcome.clickVerdicts ?? []) {
    clicks.set(name, { checkId: "click_test", tier: "RH", state: verdict.state, ...(verdict.reason ? { reason: verdict.reason } : {}), at: input.at, runId: input.runId })
  }
  return { shared, clicks }
}

/**
 * Merges the rehearsal's cells into the run state's `in_pr` column for `head`, with the column's other pre-merge
 * cells (`in-pr-cells.ts`: the jobs' static checks, the plan's answers, what Infinite holds) and the cells derived
 * from all of them (`checks_passing` over the 14 checks). `keys` is this step's read of the connections.
 */
export function recordRehearsalCells(ctx: WizardContext, outcome: RehearsalOutcome, input: { head: string; runId: string; keys?: TagKeys | null }): void {
  const at = ctx.now().toISOString()
  const fresh = rehearsalCells(outcome, { ...input, at })
  ctx.state.update((state) => {
    const previous = state.report.in_pr
    // §3i.3 rule 7: in_pr cells are keyed to the head and rebuilt on a new head. Cells that do not depend on the
    // code (plan answers, cloud reads and receipts, e.g. the consent answer or GA4 key events designated) carry
    // over; everything measured on the old head (tests, wizard checks, git-host reads) is dropped.
    const base =
      previous && previous.meta.sha === input.head
        ? previous
        : { meta: { measuredAt: at, sha: input.head }, cells: keepHeadIndependent(previous?.cells), finishLine: keepHeadIndependent(previous?.finishLine) }
    // The cells this call recomputes are dropped first, so a row that lost its evidence goes back to "—".
    const cells = { ...base.cells }
    const finishLine = { ...base.finishLine }
    for (const id of RECOMPUTED_ROWS) delete cells[id]
    for (const id of RECOMPUTED_FINISH_LINE) delete finishLine[id]
    const own = preMergeCells(state, { at, runId: input.runId, ...(input.keys !== undefined ? { keys: input.keys } : {}) })
    const column = { cells: { ...cells, ...own.cells, ...fresh.cells }, finishLine: { ...finishLine, ...own.finishLine, ...fresh.finishLine } }
    const derived = derivedInPrCells(column, state, { at, runId: input.runId })
    state.report.in_pr = { meta: { measuredAt: at, sha: input.head }, cells: { ...column.cells, ...derived.cells }, finishLine: column.finishLine }
  })
}

/** Rows and finish-line cells `recordRehearsalCells` rebuilds from the run state on every call. */
const RECOMPUTED_ROWS: readonly ReportRowId[] = ["checks_passing", "preview_share", "server_conversions", "consent_setting", "live_test_per_tool"]
const RECOMPUTED_FINISH_LINE: readonly FinishLineId[] = ["conversions_server_side", "identity_joined", "consent_recorded", "keeps_being_checked"]

/**
 * The GA4 key events Infinite marked (`marked` = created + already existing in the `ga4-key-events` response) go
 * into the `in_pr` column the rehearsal recorded; `checks_passing` is counted again. No column yet = nothing written.
 */
export function recordGa4KeyEventCells(ctx: WizardContext, marked: number, runId: string, mode: "all" | "new_names"): void {
  if (marked <= 0) return
  const at = ctx.now().toISOString()
  ctx.state.update((state) => {
    const column = state.report.in_pr
    if (!column) return
    const before = column.cells.ga4_key_events
    // The rehearsal step marks every click-tested name (its count is the whole count, on a re-run too); the review
    // step marks only names no earlier rehearsal of this run proved, so its count adds to the one recorded.
    const already = mode === "new_names" && before && before.provenance.runId === runId && typeof before.value === "number" ? before.value : 0
    const added = ga4KeyEventCells(marked, already, { at, runId })
    const finishLine = { ...column.finishLine, ...added.finishLine }
    state.report.in_pr = { meta: column.meta, cells: { ...column.cells, ...added.cells, checks_passing: checksPassingCell(finishLine, runId, column.meta.measuredAt ?? at) }, finishLine }
  })
}

const HEAD_INDEPENDENT_SOURCES = new Set(["plan_answer", "cloud_read", "cloud_receipt"])

function keepHeadIndependent<K extends string>(cells: Partial<Record<K, Cell>> | undefined): Partial<Record<K, Cell>> {
  const out: Partial<Record<K, Cell>> = {}
  for (const [id, cell] of Object.entries(cells ?? {}) as Array<[K, Cell | undefined]>) {
    if (cell && HEAD_INDEPENDENT_SOURCES.has(cell.provenance.source)) out[id] = cell
  }
  return out
}

/** One line per tool, the design's rehearsal sub-statuses. */
export function rehearsalLines(outcome: RehearsalOutcome): Array<{ text: string; tone: "ok" | "warn" | "info" }> {
  if (outcome.state === "undetermined") {
    const why: Record<RehearsalUndetermined, string> = {
      not_vercel: "Rehearsal: undetermined (no Vercel preview found for this site)",
      preview_protected: "Rehearsal: undetermined (the preview is protected)",
      no_preview: "Rehearsal: undetermined (no preview appeared within 10 minutes)",
      no_production_host: "Rehearsal: undetermined (no production host known)",
      not_github: "Rehearsal: undetermined (previews are read from GitHub only)",
      gh_unavailable: "Rehearsal: undetermined (gh is not installed or logged in, so the preview cannot be read)",
      test_error: "Rehearsal: undetermined (the test window did not finish)",
      test_busy: "Rehearsal: undetermined (the desktop's test window was busy)",
      facts_unreadable: "Rehearsal: undetermined (the Infinite app could not read the connections or hosting)"
    }
    return [{ text: why[outcome.reason ?? "test_error"], tone: "warn" }]
  }
  const lines: Array<{ text: string; tone: "ok" | "warn" | "info" }> = []
  for (const tool of ["ga4", "posthog", "meta", "infinite"] as const) {
    const result = outcome.grades[tool]
    if (!result) continue
    if (result.state === "pass") lines.push({ text: `✓ ${TOOL_LABEL[tool]} fires once · right ID`, tone: "ok" })
    else if (result.state === "problem") lines.push({ text: `${TOOL_LABEL[tool]}: ${reasonCode(result).replace(/_/g, " ") || "problem"}`, tone: "warn" })
    else if (result.state === "undetermined") lines.push({ text: `${TOOL_LABEL[tool]}: undetermined (${reasonCode(result).replace(/_/g, " ") || "unknown"})`, tone: "info" })
  }
  if (outcome.clickTested.length > 0) lines.push({ text: `✓ Conversions fire on the right buttons (${outcome.clickTested.length})`, tone: "ok" })
  const silent = rehearsalCells(outcome, { head: "", at: "", runId: "" }).finishLine.previews_silent?.state
  if (silent === "problem") lines.push({ text: "The preview link itself sends data", tone: "warn" })
  else if (silent === "pass") lines.push({ text: "✓ Preview links themselves send nothing", tone: "ok" })
  return lines
}

function conversionKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * §3e.5: the rehearsal's RH results reach the checklist items. Every item with an RH check gets the shared results
 * (one_beacon_per_tool, preview_self_silent, posthog_via_proxy_once, no_csp_violation); a `conversions_to_tools`
 * item gets the `click_test` of ITS conversion only (its target, compared without case or separators, to the
 * click's label). The registry's state machine decides each item's state; nothing is the agent's word.
 */
export function applyRehearsalToJobs(ctx: WizardContext, deps: Pick<WizardDeps, "registry">, outcome: RehearsalOutcome, runId: string): void {
  const { shared, clicks } = rehearsalCheckResults(outcome, { at: ctx.now().toISOString(), runId })
  if (shared.length === 0 && clicks.size === 0) return
  const byKey = new Map([...clicks].map(([name, result]) => [conversionKey(name), result]))
  const changes: Array<{ itemId: string; state: ChecklistItem["state"] }> = []
  ctx.state.update((state) => {
    state.jobs = state.jobs.map((job) => {
      const rh = new Set(job.checks.filter((check) => check.tier === "RH").map((check) => check.id))
      if (rh.size === 0) return job
      const results = shared.filter((result) => rh.has(result.checkId))
      if (rh.has("click_test") && job.jobId === "conversions_to_tools") {
        const target = job.id.slice(job.id.indexOf(":") + 1)
        const click = byKey.get(conversionKey(target))
        if (click) results.push(click)
      }
      if (results.length === 0) return job
      const [next] = deps.registry.apply([job], results, runId)
      if (!next) return job
      if (next.state !== job.state) changes.push({ itemId: job.id, state: next.state })
      return next
    })
  })
  for (const change of changes) ctx.emit.emit("job.state", { itemId: change.itemId, state: change.state, by: "wizard", note: "the rehearsal's results" })
}
