// The T0 scenario suite (lane O6): what the wizard asks of the emitted (or agent-edited) page bytes,
// offline, before anything is deployed. Each scenario becomes one or more sandboxed SESSIONS (`run.ts`),
// and its recordings are graded HERE, in the wizard's process, into CheckResults (tier T0). Three
// states, never four: pass, problem, undetermined (a crash or deadline is `undetermined (test error)`,
// never a pass), plus `info` for what is worth saying but not a verdict.
//
// Incidents each scenario guards (wf5-PORT-PLAN §4; every one has a negative test in scenarios.test.ts):
//   • host_matrix — "Preview leak, 5 of 44 PostHog pageviews (infinite-site 9fcbefa)": production,
//     `ACME.com.`, exempt aliases fire; `*.vercel.app`, localhost, 127.0.0.1, 0.0.0.0, `.local`,
//     `.netlify.app`, `.pages.dev` stay silent; `staging.<domain>` fires and is LABELLED (the deny list
//     cannot see it; only the 7-day host share can). The `_fbc` capture still writes on previews (D15).
//   • fbc_capture — "Two _fbc cookies; the first click shadowed later ones (06b2ce8)" and "_fbc only
//     captured down-funnel (133a0b1)": two landings with different fbclids leave ONE cookie holding the
//     second click.
//   • storage_wiped — "Meta in-app browser wiped web storage": land with UTMs + fbclid, wipe storage,
//     keep cookies, go to page 2: the campaign and `_fbc` are still there (F24).
//   • fake_click_id — decision 12: the `INFINITE_TEST_NOT_REAL_` marker never appears in any request
//     the page makes and is never stored at rest outside `_fbc`.
//   • mirror_event_id — "Phantom CompleteRegistrations (22d08d4)": a null / empty metaEventId fires ZERO
//     fbq calls; a real one fires exactly one, with that id verbatim, once per id.
//   • navigation_order — "Navigation cut off the Lead /tr (69aa95c), the hash raced the download
//     (c6c69dd)": with a /tr that completes after 50 ms the order is fbq → navigate; with one that never
//     completes the 400 ms budget releases the navigation.
//   • tags_absent — "Download button dead for GPC visitors (0df149b)": with gtag / fbq / posthog absent
//     or hung, every marked CTA still navigates or submits within 1 s.
//   • consent_matrix — the runtime consent rule for Infinite's own lanes (the collect path and the `_fbc`
//     capture): a recorded decision wins either way, DNT/GPC without a grant means no, the mode decides
//     the rest. Infinite never touches a banner; GA4 and PostHog are the site's own consent.
//   • sensitive_pages — D17: PostHog init options on sensitive paths disable replay and autocapture;
//     ordinary pages keep the defaults.
//   • one_runtime_per_page (job 2) and click_test (jobs 10, 11, static HTML / Vite markup only; React
//     component clicks are the rehearsal's).
// The parser incident ("unreadable folded into absent", b714a65) is the rule above: a session error is
// undetermined, never a pass and never an "absent".
import { getProviderAdapter } from "../providers/index.js"
import { buildManagedHtmlBlock } from "../frameworks/managed-html.js"
import type { ProviderId, WorkspaceInstallArtifacts } from "../types.js"
import { DEFAULT_INFINITE_COLLECT_PATH } from "../workspace-artifacts.js"
import type { CheckResult, Evidence, T0Scenario } from "../wizard/contracts/jobs.js"
import { normalizeHost } from "../wizard/contracts/host-deny.js"
import { FAKE_CLICK_ID_PREFIX, fakeClickIdFor } from "../wizard/contracts/test-engine.js"
import type { T0Action, T0LoaderBehaviour, T0PageSource, T0Request, T0Session, T0SessionRecording } from "./protocol.js"
import { T0_SILENCED_FBQ } from "./protocol.js"
import { runT0Sessions, type T0RunOptions, type T0RunOutcome } from "./run.js"

export const T0_SCENARIO_IDS = [
  "host_matrix",
  "consent_matrix",
  "tags_absent",
  "fbc_capture",
  "storage_wiped",
  "fake_click_id",
  "mirror_event_id",
  "navigation_order",
  "sensitive_pages",
  "one_runtime_per_page",
  "click_test"
] as const
export type T0ScenarioId = (typeof T0_SCENARIO_IDS)[number]

export class T0ScenarioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "T0ScenarioError"
  }
}

export interface T0GradeContext {
  runId: string | null
  now(): Date
}

/** A scenario turned into sessions plus the function that grades their recordings. */
export interface PlannedScenario {
  scenario: T0Scenario
  sessions: T0Session[]
  grade(recordings: T0SessionRecording[], ctx: T0GradeContext): CheckResult[]
}

/**
 * The `<code> — <detail>` reason convention for problem / undetermined / info results; `reasonCode` reads
 * the code back. A pass carries only its detail (no code), so `reasonCode` returns null for it.
 */
export function reasonCode(result: Pick<CheckResult, "reason" | "state">): string | null {
  if (!result.reason || result.state === "pass") return null
  return result.reason.split(" — ")[0] ?? null
}

function result(scenario: T0Scenario, ctx: T0GradeContext, state: CheckResult["state"], code: string | null, detail?: string, evidence?: Evidence[]): CheckResult {
  return {
    checkId: scenario.checkId,
    state,
    ...(code ? { reason: detail ? `${code} — ${detail}` : code } : detail ? { reason: detail } : {}),
    ...(evidence && evidence.length ? { evidence } : {}),
    tier: "T0",
    at: ctx.now().toISOString(),
    runId: ctx.runId
  }
}

// ---- params ------------------------------------------------------------------------------------

function str(params: Readonly<Record<string, unknown>>, key: string, scenario: string): string {
  const value = params[key]
  if (typeof value !== "string" || value.length === 0) throw new T0ScenarioError(`${scenario}: params.${key} must be a non-empty string`)
  return value
}

function optStr(params: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = params[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function strList(params: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = params[key]
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new T0ScenarioError(`params.${key} must be a string array`)
  return value as string[]
}

function sourceParam(params: Readonly<Record<string, unknown>>): T0PageSource | undefined {
  const value = params.source
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new T0ScenarioError("params.source must be an object")
  return value as T0PageSource
}

/** The production host, normalised (§3h.9) and validated as a hostname. */
function productionHostParam(params: Readonly<Record<string, unknown>>, scenario: string): string {
  const host = normalizeHost(str(params, "productionHost", scenario))
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(host)) throw new T0ScenarioError(`${scenario}: productionHost is not a hostname`)
  return host
}

// ---- the page under test -----------------------------------------------------------------------

const ARTIFACT_PROVIDER_ORDER: ProviderId[] = ["ga4", "posthog", "x", "meta", "infinite"]

const DEFAULT_BODY = '<main><h1>T0</h1><a id="t0-cta" href="/signup" data-infinite-conversion="sign_up">Sign up</a></main>'

/**
 * The static-html page infinite-tag would write for these artifacts: the managed block from each
 * provider adapter's real snippet, in the installer's provider order. A provider whose plan is blocked
 * is left out (the plan says why), exactly as the installer would.
 */
export function pageSourceFromArtifacts(artifacts: WorkspaceInstallArtifacts, bodyHtml: string = DEFAULT_BODY): T0PageSource {
  const snippets: string[] = []
  for (const provider of ARTIFACT_PROVIDER_ORDER) {
    const artifact = artifacts[provider]
    if (artifact === undefined) continue
    const plan = getProviderAdapter(provider).plan("static-html", artifact, { artifacts })
    if (plan.blockers.length > 0) continue
    for (const instruction of plan.instructions) if (instruction.snippet.trim()) snippets.push(instruction.snippet.trim())
  }
  return { html: `<!doctype html><html><head>${buildManagedHtmlBlock(snippets)}</head><body>${bodyHtml}</body></html>` }
}

function pageSource(params: Readonly<Record<string, unknown>>, artifacts: WorkspaceInstallArtifacts): T0PageSource {
  // R4-2: an adopted tool's job whose page could not be read from its files is never tested on the managed page instead.
  const sourceError = optStr(params, "sourceError")
  if (sourceError !== undefined) throw new T0ScenarioError(`the page could not be built from the job's files: ${sourceError}`)
  return sourceParam(params) ?? pageSourceFromArtifacts(artifacts, optStr(params, "bodyHtml"))
}

// ---- reading recordings ------------------------------------------------------------------------

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export interface Ga4Hit {
  tid: string
  en: string
  action: number
  at: number
}
export interface MetaHit {
  id: string
  ev: string
  eid: string
  action: number
  at: number
}
export interface PosthogHit {
  event: string
  projectKey: string
  host: string
  action: number
  at: number
}

export function ga4Hits(recording: T0SessionRecording): Ga4Hit[] {
  const hits: Ga4Hit[] = []
  for (const request of recording.requests) {
    const url = parse(request.url)
    if (!url || !/(?:^|\.)google-analytics\.com$|(?:^|\.)googletagmanager\.com$/.test(url.hostname) || !/\/(?:g|ccm)\/collect$/.test(url.pathname)) continue
    hits.push({ tid: url.searchParams.get("tid") ?? "", en: url.searchParams.get("en") ?? "", action: request.action, at: request.at })
  }
  return hits
}

export function metaHits(recording: T0SessionRecording): MetaHit[] {
  const hits: MetaHit[] = []
  for (const request of recording.requests) {
    const url = parse(request.url)
    if (!url || !/(?:^|\.)facebook\.com$/.test(url.hostname) || !/^\/tr\/?$/.test(url.pathname)) continue
    hits.push({ id: url.searchParams.get("id") ?? "", ev: url.searchParams.get("ev") ?? "", eid: url.searchParams.get("eid") ?? "", action: request.action, at: request.at })
  }
  return hits
}

export function posthogHits(recording: T0SessionRecording): PosthogHit[] {
  const hits: PosthogHit[] = []
  for (const request of recording.requests) {
    const url = parse(request.url)
    if (!url || !/\/(?:e|i\/v0\/e|batch|capture)\/?$/.test(url.pathname) || !request.body) continue
    try {
      const body = JSON.parse(request.body) as { api_key?: unknown; event?: unknown }
      if (typeof body.api_key !== "string" || typeof body.event !== "string") continue
      hits.push({ event: body.event, projectKey: body.api_key, host: url.host, action: request.action, at: request.at })
    } catch {
      continue
    }
  }
  return hits
}

export function infiniteHits(recording: T0SessionRecording, collectPath: string): Array<{ eventName: string; action: number; at: number }> {
  const hits: Array<{ eventName: string; action: number; at: number }> = []
  for (const request of recording.requests) {
    if (request.origin !== "page" || (request.kind !== "beacon" && request.kind !== "fetch")) continue
    const url = parse(request.url)
    if (!url || url.pathname !== collectPath || !request.body) continue
    try {
      const body = JSON.parse(request.body) as { eventName?: unknown }
      if (typeof body.eventName === "string") hits.push({ eventName: body.eventName, action: request.action, at: request.at })
    } catch {
      continue
    }
  }
  return hits
}

function fbqCalls(recording: T0SessionRecording, action: number): unknown[][] {
  return recording.timeline.filter((entry) => entry.kind === "fbq" && entry.action === action).map((entry) => entry.args)
}

function navigations(recording: T0SessionRecording, action?: number): T0Request[] {
  return recording.requests.filter((request) => (request.kind === "navigation" || request.kind === "form") && (action === undefined || request.action === action))
}

function cookieValue(recording: T0SessionRecording, name: string): string[] {
  return recording.cookies.filter((cookie) => cookie.name === name).map((cookie) => cookie.value)
}

type GuardedTool = "ga4" | "posthog" | "meta"
const GUARDED: readonly GuardedTool[] = ["ga4", "posthog", "meta"]

/**
 * Which guarded tools STARTED during an action: an init (`gtag('config')`, `posthog.init`,
 * `fbq('init')`) or a beacon. A vendor LOADER request alone is not a start (review O6-R23): a guard
 * around an adopted `gtag('config')` with a separate `<script src=gtag/js>` measures nothing on a preview.
 */
function toolsStarted(recording: T0SessionRecording, action: number): Set<GuardedTool> {
  const started = new Set<GuardedTool>()
  if (recording.timeline.some((entry) => entry.kind === "gtag" && entry.action === action && entry.args[0] === "config")) started.add("ga4")
  if (ga4Hits(recording).some((hit) => hit.action === action)) started.add("ga4")
  if (metaHits(recording).some((hit) => hit.action === action)) started.add("meta")
  if (posthogHits(recording).some((hit) => hit.action === action)) started.add("posthog")
  if (recording.posthogInits.some((init) => init.action === action)) started.add("posthog")
  if (fbqCalls(recording, action).some((call) => call[0] === "init")) started.add("meta")
  // B18: on a silenced host the guard's inert `fbq` swallows the site's own calls; with no /tr sent, the
  // pixel is SILENT (the flag decides, never `typeof fbq`).
  const silenced = recording.globals.some((entry) => entry.action === action && entry.defined.includes(T0_SILENCED_FBQ))
  if (silenced && !metaHits(recording).some((hit) => hit.action === action)) started.delete("meta")
  return started
}

function sessionError(scenario: T0Scenario, ctx: T0GradeContext, recordings: T0SessionRecording[]): CheckResult | null {
  const failed = recordings.find((recording) => recording.error !== null)
  return failed ? result(scenario, ctx, "undetermined", "test_error", `session ${failed.id} crashed: ${failed.error}`) : null
}

function marker(runId: string | null, suffix = ""): string {
  return `${runId ? fakeClickIdFor(runId) : `${FAKE_CLICK_ID_PREFIX}t0test`}${suffix}`
}

const FAST_LOADERS: T0LoaderBehaviour = { loadDelayMs: 10, metaTrDelayMs: 30, ga4EventCallbackDelayMs: 50 }

function load(label: string, url: string, source: T0PageSource, extra: Partial<Extract<T0Action, { kind: "load" }>> = {}): T0Action {
  return { kind: "load", label, url, source, loaders: FAST_LOADERS, ...extra }
}

// ---- host_matrix -------------------------------------------------------------------------------

interface HostRow {
  host: string
  expect: "fires" | "silent"
  note?: "leaks_deny_list" | "unknown_let_through" | "exempt"
}

/** The §1.1 / §3h.9 host matrix for one production host (S5 §1.1 table), plus exempt and extra hosts. */
export function hostMatrixRows(productionHost: string, exempt: readonly string[] = [], extra: readonly HostRow[] = []): HostRow[] {
  const label = productionHost.split(".")[0] ?? "site"
  const rows: HostRow[] = [
    { host: productionHost, expect: "fires" },
    { host: `${productionHost.toUpperCase()}.`, expect: "fires" },
    ...exempt.map((host): HostRow => ({ host: normalizeHost(host), expect: "fires", note: "exempt" })),
    { host: `${label}-abc123.vercel.app`, expect: "silent" },
    { host: "localhost", expect: "silent" },
    { host: "127.0.0.1", expect: "silent" },
    { host: "0.0.0.0", expect: "silent" },
    { host: "[::1]", expect: "silent" },
    { host: "app.localhost", expect: "silent" },
    { host: "foo.local", expect: "silent" },
    { host: "x.netlify.app", expect: "silent" },
    { host: "x.pages.dev", expect: "silent" },
    { host: `staging.${productionHost}`, expect: "fires", note: "leaks_deny_list" },
    { host: "other.example", expect: "fires", note: "unknown_let_through" },
    ...extra
  ]
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = row.host
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The guarded tools the page under test is meant to start: `params.tools`, else the artifacts' (default page only). */
function expectedGuardedTools(params: Readonly<Record<string, unknown>>, artifacts: WorkspaceInstallArtifacts): GuardedTool[] | null {
  const named = strList(params, "tools")
  if (named.length) {
    const unknown = named.filter((tool) => !(GUARDED as readonly string[]).includes(tool))
    if (unknown.length) throw new T0ScenarioError(`host_matrix: params.tools may name ga4, posthog, meta (not ${unknown.join(", ")})`)
    return named as GuardedTool[]
  }
  // A caller-supplied page may carry any subset; without `params.tools` production itself is the reference.
  if (params.source !== undefined) return null
  return GUARDED.filter((tool) => artifacts[tool] !== undefined)
}

function planHostMatrix(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts, runId: string | null): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "host_matrix")
  const exempt = strList(scenario.params, "exempt")
  const rows = hostMatrixRows(productionHost, exempt)
  const source = pageSource(scenario.params, artifacts)
  const expected = expectedGuardedTools(scenario.params, artifacts)
  const clickId = marker(runId, "_HM")
  const sessions: T0Session[] = rows.map((row, index) => ({
    id: `host:${index}`,
    actions: [load(row.host, `https://${row.host}/?fbclid=${clickId}`, source)]
  }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const production = toolsStarted(recordings[0]!, 0)
      const reference = new Set<GuardedTool>([...(expected ?? []), ...production])
      const leaking: string[] = []
      const silentWhereItMustFire: string[] = []
      const captureMissing: string[] = []
      const evidence: Evidence[] = []
      const leaks: string[] = []
      // Only where the production load itself captured (consent can hold the capture everywhere).
      const captureExpected = recordings[0]!.cookieWrites.some((write) => write.value.startsWith("_fbc="))
      rows.forEach((row, index) => {
        const started = toolsStarted(recordings[index]!, 0)
        if (row.expect === "fires") {
          const missing = [...reference].filter((tool) => !started.has(tool)).sort()
          if (missing.length) {
            silentWhereItMustFire.push(`${row.host}: ${missing.join(", ")} silent on a host that must fire`)
            evidence.push({ url: `https://${row.host}/` })
          }
          if (row.note === "leaks_deny_list" && started.size) leaks.push(row.host)
        } else {
          // Graded whatever production did (review O6-R7): an INVERTED guard is silent on production and
          // fires on every preview, and that is the worst guard bug there is.
          const fired = [...started]
          if (fired.length) {
            leaking.push(`${row.host}: ${fired.sort().join(", ")} fire on a preview / local host`)
            evidence.push({ url: `https://${row.host}/` })
          }
          // D15: the capture is never host-guarded, so previews can still test it.
          if (captureExpected && !recordings[index]!.cookieWrites.some((write) => write.value.startsWith("_fbc="))) {
            captureMissing.push(`${row.host}: the _fbc capture did not run (it must not be host-guarded)`)
            evidence.push({ url: `https://${row.host}/` })
          }
        }
      })
      const problems = [...leaking, ...silentWhereItMustFire, ...captureMissing]
      if (reference.size === 0 && problems.length === 0)
        return [result(scenario, ctx, "undetermined", "not_installed", "no guarded tool (GA4, PostHog, Meta) starts on any host")]
      const code = leaking.length ? "previews_send_data" : silentWhereItMustFire.length ? "production_silent" : "no_fbc_capture"
      const out = [
        problems.length
          ? result(scenario, ctx, "problem", code, problems.join("; "), evidence)
          : result(scenario, ctx, "pass", null, `${rows.length} hosts: production and exempt hosts fire, previews and local hosts stay silent`)
      ]
      if (leaks.length) out.push(result(scenario, ctx, "info", "leaks_deny_list", `${leaks.join(", ")} fires: a deny list cannot tell a custom staging host from production; only the 7-day host share can`))
      return out
    }
  }
}

// ---- consent_matrix ----------------------------------------------------------------------------

type StoredDecision = "granted" | "denied" | "none"
type PrivacySignal = "none" | "dnt" | "gpc"

/** The runtime's consent rule (runtime `hasConsent`, meta-browser `consentAllowsSource`). */
export function consentAllows(mode: "required" | "not_required", stored: StoredDecision, signal: PrivacySignal): boolean {
  if (stored === "granted") return true
  if (stored === "denied") return false
  if (signal !== "none") return false
  return mode === "not_required"
}

function planConsentMatrix(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts, runId: string | null): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "consent_matrix")
  const mode = optStr(scenario.params, "consentMode") ?? artifacts.infinite?.consentMode
  if (mode !== "required" && mode !== "not_required") throw new T0ScenarioError("consent_matrix: consentMode must be required or not_required")
  const storageKey = optStr(scenario.params, "consentStorageKey") ?? "infinite_analytics_consent"
  const collectPath = optStr(scenario.params, "collectPath") ?? artifacts.infinite?.collectPath ?? DEFAULT_INFINITE_COLLECT_PATH
  const source = pageSource(scenario.params, artifacts)
  const clickId = marker(runId, "_CM")
  const rows: Array<{ stored: StoredDecision; signal: PrivacySignal }> = []
  for (const stored of ["granted", "denied", "none"] as const) for (const signal of ["none", "dnt", "gpc"] as const) rows.push({ stored, signal })
  const sessions: T0Session[] = rows.map((row, index) => ({
    id: `consent:${index}`,
    actions: [
      ...(row.stored === "none" ? [] : [{ kind: "set_storage", label: "seed", area: "local", key: storageKey, value: row.stored } as T0Action]),
      load(`${row.stored}/${row.signal}`, `https://${productionHost}/?fbclid=${clickId}`, source, {
        doNotTrack: row.signal === "dnt" ? "1" : null,
        globalPrivacyControl: row.signal === "gpc"
      })
    ]
  }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const loadAction = (index: number) => (rows[index]!.stored === "none" ? 0 : 1)
      const first = recordings.findIndex((_recording, index) => rows[index]!.stored === "granted")
      const defined = recordings[first]!.globals[0]?.defined ?? []
      const hasRuntime = defined.includes("__infiniteAnalyticsRuntime")
      const hasCapture = defined.includes("infiniteMetaClickId")
      if (!hasRuntime && !hasCapture) return [result(scenario, ctx, "undetermined", "not_installed", "neither Infinite's runtime nor the _fbc capture is on this page")]
      const problems: string[] = []
      rows.forEach((row, index) => {
        const recording = recordings[index]!
        const allowed = consentAllows(mode, row.stored, row.signal)
        if (hasRuntime) {
          const sent = infiniteHits(recording, collectPath).some((hit) => hit.action === loadAction(index))
          if (sent !== allowed) problems.push(`Infinite ${sent ? "collected" : "did not collect"} with decision=${row.stored}, signal=${row.signal} (expected ${allowed ? "collect" : "nothing"})`)
        }
        if (hasCapture) {
          const wrote = recording.cookieWrites.some((write) => write.value.startsWith("_fbc="))
          if (wrote !== allowed) problems.push(`the _fbc capture ${wrote ? "wrote" : "did not write"} with decision=${row.stored}, signal=${row.signal}`)
        }
      })
      return [
        problems.length
          ? result(scenario, ctx, "problem", "consent_rule", problems.join("; "))
          : result(scenario, ctx, "pass", null, `consent_mode=${mode}: ${rows.length} decision/signal combinations follow the runtime rule`)
      ]
    }
  }
}

// ---- fbc_capture / storage_wiped / fake_click_id -----------------------------------------------

function planFbcCapture(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts, runId: string | null): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "fbc_capture")
  const source = pageSource(scenario.params, artifacts)
  const firstClick = marker(runId, "_FIRST")
  const secondClick = marker(runId, "_SECOND")
  const sessions: T0Session[] = [
    {
      id: "fbc:two-landings",
      actions: [
        load("landing-1", `https://${productionHost}/?fbclid=${firstClick}`, source),
        load("landing-2", `https://${productionHost}/pricing?fbclid=${secondClick}`, source),
        load("page-3", `https://${productionHost}/about`, source)
      ]
    }
  ]
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const recording = recordings[0]!
      const values = cookieValue(recording, "_fbc")
      if (recording.cookieWrites.filter((write) => write.value.startsWith("_fbc=")).length === 0)
        // LF4 close round 2 (P2-2): no capture on the page at all is the job's change MISSING, not a wrong one.
        return [{ ...result(scenario, ctx, "problem", "no_fbc_capture", "a landing with an fbclid wrote no _fbc cookie"), absent: true }]
      if (values.length !== 1) return [result(scenario, ctx, "problem", "two_fbc_cookies", `${values.length} _fbc cookies are visible after two landings; Meta reads the first, so an older click shadows the newer one`)]
      if (!/^fb\.\d\.\d{13}\./.test(values[0]!) || !values[0]!.endsWith(`.${secondClick}`))
        return [result(scenario, ctx, "problem", "fbc_not_last_click", "the stored _fbc does not hold the newest click in Meta's fb.<index>.<ms>.<fbclid> format")]
      return [result(scenario, ctx, "pass", null, "one _fbc cookie, holding the last click, survives the next page")]
    }
  }
}

function planStorageWiped(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts, runId: string | null): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "storage_wiped")
  const source = pageSource(scenario.params, artifacts)
  const clickId = marker(runId, "_F24")
  const campaign = "t0_campaign_f24"
  const expectCampaign = scenario.params.expectCampaign !== false
  const sessions: T0Session[] = [
    {
      id: "f24",
      actions: [
        load("landing", `https://${productionHost}/?utm_source=t0&utm_medium=paid_social&utm_campaign=${campaign}&fbclid=${clickId}`, source),
        { kind: "clear_storage", label: "in-app browser wipes web storage", local: true, session: true },
        load("page-2", `https://${productionHost}/pricing`, source)
      ]
    }
  ]
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const recording = recordings[0]!
      const problems: string[] = []
      const fbc = cookieValue(recording, "_fbc")
      if (!fbc.some((value) => value.endsWith(`.${clickId}`))) problems.push("the _fbc click id did not survive the storage wipe")
      if (expectCampaign && !recording.cookies.some((cookie) => cookie.name !== "_fbc" && decodeURIComponent(cookie.value).includes(campaign)))
        problems.push("the campaign (utm_campaign) is lost once web storage is wiped: no first-party cookie carries it to page 2")
      return [
        problems.length
          ? result(scenario, ctx, "problem", "attribution_lost", problems.join("; "))
          : result(scenario, ctx, "pass", null, "page 2 still carries the campaign and _fbc after the storage wipe")
      ]
    }
  }
}

function planFakeClickId(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts, runId: string | null): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "fake_click_id")
  const source = pageSource(scenario.params, artifacts)
  const clickId = marker(runId)
  const selectors = strList(scenario.params, "clickSelectors")
  const landing = `https://${productionHost}/?fbclid=${clickId}`
  const sessions: T0Session[] = [
    {
      id: "marker",
      actions: [
        load("landing", landing, source),
        ...selectors.map((selector, index): T0Action => ({ kind: "click", label: `click-${index}`, selector })),
        load("page-2", `https://${productionHost}/pricing`, source)
      ]
    }
  ]
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const recording = recordings[0]!
      const leaks: Evidence[] = []
      const where: string[] = []
      for (const request of recording.requests) {
        // §3h.4 row 2: the run's own target URL as the top-level document is the one allowed carrier.
        if (request.kind === "navigation" && request.url === landing) continue
        // The vendor stand-ins echo the page URL (`dl`, `$current_url`) exactly as the real libraries do;
        // the desktop cancels those in every dry mode (§3h.4 row 3). A leak is the SITE's own code
        // carrying the click id somewhere: a fetch, a beacon, a pixel image, a script URL.
        if (request.origin !== "page") continue
        const carries = request.url.includes(FAKE_CLICK_ID_PREFIX) || (request.body ?? "").includes(FAKE_CLICK_ID_PREFIX)
        if (!carries) continue
        const url = parse(request.url)
        where.push(`${request.kind} to ${url ? `${url.host}${url.pathname}` : "an unparseable URL"}`)
        if (url) leaks.push({ url: `${url.origin}${url.pathname}` })
      }
      const storedKeys = new Set<string>()
      for (const write of recording.storageWrites) {
        if (write.value.includes(FAKE_CLICK_ID_PREFIX) || write.key.includes(FAKE_CLICK_ID_PREFIX)) storedKeys.add(`${write.area}Storage["${write.key.includes(FAKE_CLICK_ID_PREFIX) ? "…" : write.key}"]`)
      }
      for (const key of storedKeys) where.push(`${key} (a raw click id at rest)`)
      return [
        where.length
          ? result(scenario, ctx, "problem", "fake_click_id_leaked", `the test click id reached ${where.join("; ")}`, leaks)
          : result(scenario, ctx, "pass", null, "the test click id stayed in the landing URL and the _fbc cookie")
      ]
    }
  }
}

// ---- mirror_event_id / navigation_order --------------------------------------------------------

function mirrorTrackCalls(calls: unknown[][]): unknown[][] {
  return calls.filter((call) => call[0] === "track" || call[0] === "trackSingle" || call[0] === "trackCustom")
}

function planMirror(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "mirror_event_id")
  const source = pageSource(scenario.params, artifacts)
  const eventName = optStr(scenario.params, "eventName") ?? "Lead"
  const realId = "t0-meta-event-id-0001"
  const call = (id: string) => `window.infiniteMetaMirror ? window.infiniteMetaMirror(${JSON.stringify(eventName)}, ${id}, { budgetMs: 400 }) : "absent"`
  const sessions: T0Session[] = [
    {
      id: "mirror",
      actions: [
        load("page", `https://${productionHost}/signup`, source),
        { kind: "eval", label: "null", expression: call("null") },
        { kind: "eval", label: "empty", expression: call('""') },
        { kind: "eval", label: "absent", expression: call("undefined") },
        { kind: "eval", label: "real", expression: call(JSON.stringify(realId)) },
        { kind: "eval", label: "real-again", expression: call(JSON.stringify(realId)) },
        { kind: "eval", label: "purchase", expression: `window.infiniteMetaMirror ? window.infiniteMetaMirror("Purchase", "t0-purchase-0001") : "absent"` }
      ]
    }
  ]
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const recording = recordings[0]!
      if (recording.actions[1]?.result === "absent") return [result(scenario, ctx, "undetermined", "not_installed", "window.infiniteMetaMirror is not on the page")]
      const problems: string[] = []
      for (const [index, label] of [[1, "null"], [2, "empty"], [3, "absent"]] as const) {
        if (mirrorTrackCalls(fbqCalls(recording, index)).length) problems.push(`a ${label} metaEventId fired fbq (phantom conversion)`)
      }
      const real = mirrorTrackCalls(fbqCalls(recording, 4))
      const eid = (entry: unknown[]) => {
        const options = entry[3] as { eventID?: unknown } | undefined
        return options && typeof options === "object" ? options.eventID : undefined
      }
      if (real.length !== 1 || real[0]![1] !== eventName || eid(real[0]!) !== realId) problems.push(`a real metaEventId must fire exactly one fbq('track', '${eventName}', …, {eventID}) with the id verbatim`)
      if (mirrorTrackCalls(fbqCalls(recording, 5)).length) problems.push("the same metaEventId fired twice (decision 18: once per id)")
      if (mirrorTrackCalls(fbqCalls(recording, 6)).length) problems.push("Purchase was mirrored from the page (it comes from the payment webhook only)")
      return [
        problems.length
          ? result(scenario, ctx, "problem", "mirror_event_id", problems.join("; "))
          : result(scenario, ctx, "pass", null, "null/empty/absent ids fire nothing; a real id fires once, verbatim; Purchase is refused")
      ]
    }
  }
}

function planNavigationOrder(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "navigation_order")
  const source = pageSource(scenario.params, artifacts)
  const eventName = optStr(scenario.params, "eventName") ?? "Lead"
  const expression = (id: string) =>
    `window.infiniteMetaMirror ? Promise.resolve(window.infiniteMetaMirror(${JSON.stringify(eventName)}, ${JSON.stringify(id)}, { wait: "request", budgetMs: 400 })).then(function () { location.assign("/thanks/"); return "navigated"; }) : "absent"`
  const variants: Array<{ id: string; trDelay: number | "never" }> = [
    { id: "t0-order-50ms", trDelay: 50 },
    { id: "t0-order-never", trDelay: "never" }
  ]
  const sessions: T0Session[] = variants.map((variant) => ({
    id: `order:${variant.trDelay}`,
    actions: [
      load("page", `https://${productionHost}/signup`, source, { loaders: { ...FAST_LOADERS, metaTrDelayMs: variant.trDelay } }),
      { kind: "eval", label: "convert-then-navigate", expression: expression(variant.id), settleMs: 2000 }
    ]
  }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      if (recordings[0]!.actions[1]?.result === "absent") return [result(scenario, ctx, "undetermined", "not_installed", "window.infiniteMetaMirror is not on the page")]
      if (!recordings[0]!.globals[0]?.defined.includes("fbq")) return [result(scenario, ctx, "undetermined", "not_installed", "no Meta pixel on the page")]
      const problems: string[] = []
      recordings.forEach((recording, index) => {
        const variant = variants[index]!
        const order = recording.timeline.filter((entry) => entry.action === 1 && (entry.kind === "fbq" || entry.kind === "navigate")).map((entry) => entry.kind)
        if (order.join(",") !== "fbq,navigate") problems.push(`tr ${variant.trDelay}: order was [${order.join(", ")}], expected [fbq, navigate]`)
        const fbqAt = recording.timeline.find((entry) => entry.action === 1 && entry.kind === "fbq")?.at
        const navAt = navigations(recording, 1)[0]?.at
        if (fbqAt !== undefined && navAt !== undefined) {
          const waited = navAt - fbqAt
          if (variant.trDelay === "never" && (waited < 400 || waited > 450)) problems.push(`with a /tr that never completes the navigation waited ${waited} ms (expected the 400 ms budget)`)
          if (typeof variant.trDelay === "number" && waited < variant.trDelay) problems.push(`the navigation left ${waited} ms after fbq, before the /tr request completed (${variant.trDelay} ms)`)
          if (typeof variant.trDelay === "number" && waited > 400) problems.push(`the navigation waited ${waited} ms although the /tr completed at ${variant.trDelay} ms`)
        }
      })
      return [
        problems.length
          ? result(scenario, ctx, "problem", "navigation_order", problems.join("; "))
          : result(scenario, ctx, "pass", null, "fbq before navigate; the navigation waits for the /tr request or the 400 ms budget, whichever is first")
      ]
    }
  }
}

// ---- tags_absent / click_test ------------------------------------------------------------------

function planTagsAbsent(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "tags_absent")
  const source = pageSource(scenario.params, artifacts)
  const selectors = strList(scenario.params, "selectors")
  const targets = selectors.length ? selectors : ["[data-infinite-conversion]"]
  const path = optStr(scenario.params, "path") ?? "/"
  const variants: Array<{ id: string; loaders: T0LoaderBehaviour; strip: boolean }> = [
    { id: "blocked", loaders: { gtag: "blocked", fbevents: "blocked", posthog: "blocked", metaTrDelayMs: "never", ga4EventCallback: "never" }, strip: false },
    { id: "hung", loaders: { ...FAST_LOADERS, metaTrDelayMs: "never", ga4EventCallback: "never" }, strip: false },
    { id: "undefined", loaders: {}, strip: true }
  ]
  // "undefined": the vendor globals are removed after the page scripts ran (GPC / an ad blocker that
  // strips the snippets entirely), so helpers must cope with gtag / fbq / posthog being undefined.
  const strip = "delete window.gtag; delete window.fbq; delete window.posthog; delete window.dataLayer; true"
  const sessions: T0Session[] = variants.map((variant) => ({
    id: `absent:${variant.id}`,
    actions: [
      load("page", `https://${productionHost}${path}`, source, { loaders: variant.loaders, globalPrivacyControl: variant.id === "blocked" }),
      ...(variant.strip ? [{ kind: "eval", label: "strip vendor globals", expression: strip, settleMs: 0 } as T0Action] : []),
      ...targets.map((selector, index): T0Action => ({ kind: "click", label: `cta-${index}`, selector, settleMs: 1000 }))
    ]
  }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const problems: string[] = []
      let exercised = 0
      recordings.forEach((recording, index) => {
        const variant = variants[index]!
        const offset = variant.strip ? 2 : 1
        targets.forEach((selector, clickIndex) => {
          const action = offset + clickIndex
          const record = recording.actions[action]
          if (!record?.found) return
          exercised += 1
          const left = navigations(recording, action)[0]
          if (!left) problems.push(`${variant.id}: "${selector}" never navigated or submitted`)
          else if (left.at - record.startedAt > 1000) problems.push(`${variant.id}: "${selector}" took ${left.at - record.startedAt} ms to navigate`)
        })
      })
      if (exercised === 0) return [result(scenario, ctx, "undetermined", "not_exercised", `no element matched ${targets.join(", ")} in the page's static markup`)]
      return [
        problems.length
          ? result(scenario, ctx, "problem", "dead_cta", problems.join("; "))
          : result(scenario, ctx, "pass", null, "every marked CTA still navigates within 1 s with the tags blocked, hung or undefined")
      ]
    }
  }
}

const META_STANDARD_EVENTS = new Set([
  "AddPaymentInfo",
  "AddToCart",
  "AddToWishlist",
  "CompleteRegistration",
  "Contact",
  "CustomizeProduct",
  "Donate",
  "FindLocation",
  "InitiateCheckout",
  "Lead",
  "Purchase",
  "Schedule",
  "Search",
  "StartTrial",
  "SubmitApplication",
  "Subscribe"
])

interface ClickSpec {
  selector: string
  label: string
  expect: { ga4?: string[]; posthog?: string[]; infinite?: string[] }
}

function clickSpecs(params: Readonly<Record<string, unknown>>): ClickSpec[] {
  const value = params.clicks
  if (!Array.isArray(value) || value.length === 0) throw new T0ScenarioError("click_test: params.clicks must list at least one {selector, label, expect}")
  return value.map((entry) => {
    const spec = entry as ClickSpec
    if (!spec || typeof spec.selector !== "string" || typeof spec.label !== "string" || !spec.expect || typeof spec.expect !== "object")
      throw new T0ScenarioError("click_test: each click needs selector, label and expect")
    // The label travels in the reason as `label=<name>;` (clickTestLabel), so it is a plain event name.
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(spec.label)) throw new T0ScenarioError(`click_test: label ${JSON.stringify(spec.label)} must be a plain event name`)
    // A click that expects nothing passes vacuously, and a pass marks key events (review O6-R13).
    const named = (["ga4", "posthog", "infinite"] as const).flatMap((tool) => {
      const list = spec.expect[tool]
      if (list !== undefined && (!Array.isArray(list) || list.some((name) => typeof name !== "string"))) throw new T0ScenarioError(`click_test: expect.${tool} must be a string array`)
      return list ?? []
    })
    if (named.length === 0) throw new T0ScenarioError(`click_test: the click ${spec.label} must expect at least one event (expect.ga4 / posthog / infinite)`)
    return spec
  })
}

/** Module scripts T0 records but never runs (a Vite entry): handlers living there are not exercised. */
function hasModuleScripts(source: T0PageSource): boolean {
  return /<script\b[^>]*\btype\s*=\s*["']?module\b/i.test(source.html ?? "")
}

/** `label=<label>; …` — the click a click_test result is about (O3 PATCHes `clickTestedConversions` from it). */
export function clickTestLabel(checkResult: Pick<CheckResult, "reason">): string | null {
  const match = /(?:^|— )label=([^;]+);/.exec(checkResult.reason ?? "")
  return match ? match[1]!.trim() : null
}

function planClickTest(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "click_test")
  const source = pageSource(scenario.params, artifacts)
  const path = optStr(scenario.params, "path") ?? "/"
  const framework = optStr(scenario.params, "framework") ?? "static-html"
  const collectPath = optStr(scenario.params, "collectPath") ?? artifacts.infinite?.collectPath ?? DEFAULT_INFINITE_COLLECT_PATH
  const clicks = clickSpecs(scenario.params)
  const unexercisedModules = framework !== "static-html" && hasModuleScripts(source)
  // One session per click, so each is graded on a fresh page.
  const sessions: T0Session[] = clicks.map((click, index) => ({
    id: `click:${index}`,
    actions: [load("page", `https://${productionHost}${path}`, source), { kind: "click", label: click.label, selector: click.selector, settleMs: 1500 }]
  }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      return clicks.map((click, index) => {
        const recording = recordings[index]!
        const prefix = `label=${click.label}; `
        if (!recording.actions[1]?.found) {
          // Static HTML: the agent put the conversion in the markup, so not finding it is a problem. Vite:
          // the element is usually rendered by React, which T0 never runs (the rehearsal clicks it).
          return framework === "static-html"
            ? result(scenario, ctx, "problem", "element_missing", `${prefix}no element matches ${click.selector} on ${path}`)
            : result(scenario, ctx, "undetermined", "not_exercised", `${prefix}${click.selector} is not in the static markup (a rendered component; the rehearsal clicks it)`)
        }
        const ga4 = ga4Hits(recording).filter((hit) => hit.action === 1 && hit.en !== "page_view").map((hit) => hit.en)
        const posthog = posthogHits(recording).filter((hit) => hit.action === 1 && hit.event !== "$pageview").map((hit) => hit.event)
        const infinite = infiniteHits(recording, collectPath).filter((hit) => hit.action === 1 && hit.eventName !== "site_page_view").map((hit) => hit.eventName)
        const meta = metaHits(recording).filter((hit) => hit.action === 1 && hit.ev !== "PageView").map((hit) => hit.ev)
        const problems: string[] = []
        let expectedSeen = 0
        for (const [tool, seen] of [["ga4", ga4], ["posthog", posthog], ["infinite", infinite]] as const) {
          for (const name of click.expect[tool] ?? []) {
            if (seen.includes(name)) expectedSeen += 1
            else problems.push(`${tool} did not receive ${name}`)
          }
        }
        const standard = meta.filter((ev) => META_STANDARD_EVENTS.has(ev))
        // Vite and friends: the handler may live in a module script T0 never runs (review O6-R14). A
        // silent click there is not exercised, never a problem; a standard fbq conversion still is.
        if (unexercisedModules && expectedSeen === 0 && standard.length === 0)
          return result(scenario, ctx, "undetermined", "not_exercised", `${prefix}the page's handlers may live in module scripts T0 does not run (${framework}); the rehearsal clicks it`)
        if (standard.length) problems.push(`fbq sent a standard conversion (${standard.join(", ")}) on a click; browser conversions go only through the server-instructed mirror`)
        const nav = navigations(recording, 1)[0]
        if (nav) {
          const ga4After = ga4Hits(recording).filter((hit) => hit.action === 1 && hit.en !== "page_view" && hit.at > nav.at)
          if (ga4After.length) problems.push("the page navigated before the GA4 event was sent")
        }
        const fired = [`ga4: ${ga4.join(", ") || "—"}`, `posthog: ${posthog.join(", ") || "—"}`, `infinite: ${infinite.join(", ") || "—"}`].join(" · ")
        return problems.length
          ? result(scenario, ctx, "problem", "click_test", `${prefix}${problems.join("; ")} (${fired})`)
          : result(scenario, ctx, "pass", null, `${prefix}fires ${fired}`)
      })
    }
  }
}

// ---- sensitive_pages / one_runtime_per_page ----------------------------------------------------

function planSensitivePages(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "sensitive_pages")
  const source = pageSource(scenario.params, artifacts)
  const sensitive = strList(scenario.params, "sensitivePaths")
  if (sensitive.length === 0) throw new T0ScenarioError("sensitive_pages: params.sensitivePaths must name at least one path")
  const ordinary = optStr(scenario.params, "ordinaryPath") ?? "/"
  const paths = [...sensitive, ordinary]
  const sessions: T0Session[] = paths.map((path, index) => ({ id: `sensitive:${index}`, actions: [load(path, `https://${productionHost}${path}`, source)] }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const problems: string[] = []
      let inits = 0
      paths.forEach((path, index) => {
        const init = recordings[index]!.posthogInits.find((entry) => entry.action === 0)
        if (!init) return
        inits += 1
        const replayOff = init.options.disable_session_recording === true
        const autocaptureOff = init.options.autocapture === false
        if (index < sensitive.length && (!replayOff || !autocaptureOff)) problems.push(`${path}: replay ${replayOff ? "off" : "ON"}, autocapture ${autocaptureOff ? "off" : "ON"} on a sensitive page`)
        if (index === sensitive.length && (replayOff || autocaptureOff)) problems.push(`${path}: an ordinary page lost PostHog's defaults (replay ${replayOff ? "off" : "on"}, autocapture ${autocaptureOff ? "off" : "on"})`)
      })
      if (inits === 0) return [result(scenario, ctx, "undetermined", "not_installed", "posthog.init never ran on these pages")]
      return [
        problems.length
          ? result(scenario, ctx, "problem", "sensitive_pages", problems.join("; "))
          : result(scenario, ctx, "pass", null, `replay and autocapture off on ${sensitive.join(", ")}; defaults on ${ordinary}`)
      ]
    }
  }
}

function planOneRuntimePerPage(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts): PlannedScenario {
  const productionHost = productionHostParam(scenario.params, "one_runtime_per_page")
  const pagesParam = scenario.params.pages
  const pages: Array<{ path: string; source: T0PageSource }> =
    Array.isArray(pagesParam) && pagesParam.length
      ? (pagesParam as Array<{ path: string; source: T0PageSource }>)
      : [{ path: "/", source: pageSource(scenario.params, artifacts) }]
  const sessions: T0Session[] = pages.map((page, index) => ({ id: `runtime:${index}`, actions: [load(page.path, `https://${productionHost}${page.path}`, page.source)] }))
  return {
    scenario,
    sessions,
    grade(recordings, ctx) {
      const crashed = sessionError(scenario, ctx, recordings)
      if (crashed) return [crashed]
      const problems: string[] = []
      pages.forEach((page, index) => {
        const recording = recordings[index]!
        const defined = recording.globals[0]?.defined ?? []
        if (!defined.includes("__infiniteAnalyticsRuntime") && !defined.includes("gtag") && !defined.includes("posthog") && !defined.includes("fbq"))
          problems.push(`${page.path}: no managed tag ran (it is not in this page's shell)`)
        const configs = recording.timeline.filter((entry) => entry.kind === "gtag" && entry.args[0] === "config").map((entry) => String(entry.args[1]))
        const pixels = fbqCalls(recording, 0).filter((call) => call[0] === "init" && call.length === 2).map((call) => String(call[1]))
        const keys = recording.posthogInits.map((init) => init.projectKey)
        for (const [what, ids] of [["gtag config", configs], ["fbq init", pixels], ["posthog.init", keys]] as const) {
          const counts = new Map<string, number>()
          for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
          for (const [id, count] of counts) if (count > 1) problems.push(`${page.path}: ${what} for ${id} ran ${count} times`)
        }
      })
      return [
        problems.length
          ? result(scenario, ctx, "problem", "one_runtime_per_page", problems.join("; "))
          : result(scenario, ctx, "pass", null, `${pages.length} page(s): the managed tag runs once on each`)
      ]
    }
  }
}

// ---- entry points ------------------------------------------------------------------------------

/** Turn one scenario into sessions + a grader. Unknown ids and bad params throw `T0ScenarioError`. */
export function planScenario(scenario: T0Scenario, artifacts: WorkspaceInstallArtifacts, runId: string | null): PlannedScenario {
  // The scenario id names the scenario; a caller that uses its own ids (e.g. `<item>:<checkId>`) names it
  // through `checkId` instead.
  const known = (id: string): id is T0ScenarioId => (T0_SCENARIO_IDS as readonly string[]).includes(id)
  const id = known(scenario.id) ? scenario.id : known(scenario.checkId) ? scenario.checkId : scenario.id
  switch (id as T0ScenarioId) {
    case "host_matrix":
      return planHostMatrix(scenario, artifacts, runId)
    case "consent_matrix":
      return planConsentMatrix(scenario, artifacts, runId)
    case "tags_absent":
      return planTagsAbsent(scenario, artifacts)
    case "fbc_capture":
      return planFbcCapture(scenario, artifacts, runId)
    case "storage_wiped":
      return planStorageWiped(scenario, artifacts, runId)
    case "fake_click_id":
      return planFakeClickId(scenario, artifacts, runId)
    case "mirror_event_id":
      return planMirror(scenario, artifacts)
    case "navigation_order":
      return planNavigationOrder(scenario, artifacts)
    case "sensitive_pages":
      return planSensitivePages(scenario, artifacts)
    case "one_runtime_per_page":
      return planOneRuntimePerPage(scenario, artifacts)
    case "click_test":
      return planClickTest(scenario, artifacts)
    default:
      throw new T0ScenarioError(`unknown T0 scenario: ${scenario.id} (check ${scenario.checkId})`)
  }
}

export interface RunT0ScenariosOptions extends T0RunOptions {
  runId: string | null
  now(): Date
  /** Test seam: replaces the sandboxed run (e.g. to simulate a crash). */
  run?: (sessions: readonly T0Session[], options: T0RunOptions) => Promise<T0RunOutcome>
}

/**
 * Plan every scenario, run ALL their sessions in one sandboxed child, and grade. A failed run (crash,
 * deadline, sandbox unavailable, unparseable output) makes every scenario `undetermined (test_error)`.
 */
export async function runT0Scenarios(scenarios: readonly T0Scenario[], artifacts: WorkspaceInstallArtifacts, options: RunT0ScenariosOptions): Promise<CheckResult[]> {
  const ctx: T0GradeContext = { runId: options.runId, now: options.now }
  const planned = scenarios.map((scenario) => planScenario(scenario, artifacts, options.runId))
  const sessions: T0Session[] = []
  const owners: number[] = []
  planned.forEach((plan, index) => {
    for (const session of plan.sessions) {
      sessions.push({ ...session, id: `${index}/${session.id}` })
      owners.push(index)
    }
  })
  const run = options.run ?? runT0Sessions
  const outcome = await run(sessions, options)
  if (!outcome.ok) {
    return planned.map((plan) => result(plan.scenario, ctx, "undetermined", "test_error", `${outcome.reason}: ${outcome.detail}`))
  }
  const out: CheckResult[] = []
  planned.forEach((plan, index) => {
    const recordings = outcome.response.sessions.filter((_session, at) => owners[at] === index)
    out.push(...plan.grade(recordings, ctx))
  })
  return out
}
