// THE grader of the desktop test engine's facts (§3h.8; lane O6). The desktop returns FACTS only
// (§3h.5: beacons, ids, counts, cookies, environment flags); this module is the one place they become
// pass / problem / undetermined / info. Nothing grades them anywhere else: not the desktop, not the cloud
// (the cloud grades receipts, its own read), not a step.
//
// Per tool, first match wins:
//   0. §3x.5 (C): the test window did not look like a normal browser (its UA is not exactly the reduced Chrome UA)
//      → every tool `undetermined (test_error)`: a window that announces itself as a monitor is dropped by Meta's
//      pixel (fbevents botblocking) and GA4's bot filter, so its silence proves nothing (run 3);
//   1. the environment makes the load ungradable → undetermined: `automation_detected`
//      (`navigator.webdriver`), `blocked_by_site_bot_rules`, `preview_protected`; and no page actually
//      loaded (no load rendered with a 2xx/3xx: a 5xx, a 404 preview, a timeout) → `test_error`, because
//      a page that never ran says nothing about its tags (review O6-R5);
//   2. a `preview_self` load (the preview's own URL): a GA4 / PostHog / Meta beacon → problem
//      `previews_send_data`; silence is the pass. Infinite is not a guarded tool and is graded normally;
//   3. Meta: `traffic_permissions_blocked` in the console → problem; a `/tr` answered 4xx → problem
//      `meta_tr_rejected` (only a real visit can see a status; dry modes cancel `/tr`);
//   4. `pii` counted for the lane → problem `no_pii` (counts only; the desktop never returns a value);
//   5. more than one `page_view` / `$pageview` per load per id → problem `duplicate_page_view`;
//   6. no beacon at all from the tool:
//      - held by consent → undetermined `held_by_consent` (consent_mode = required and the seed had no
//        effect, or a third-party CMP was detected). NEVER a problem: no agent job is ever seeded against
//        consent wiring, and Infinite never touches a banner. The test-only seed releases Infinite AND a
//        MANAGED Meta pixel (both read the seeded key), so for those a seeded silence is not consent;
//      - the caller did not say the site's consent mode → undetermined `test_error` (never guessed);
//      - the id is env-sourced (census `envSourcedIds`) and the build is a preview → undetermined
//        `env_dependent`;
//      - the tool is installed → problem `no_beacon`; not installed → `info` (`not_installed`);
//      - the caller did not say what is installed → undetermined `test_error` (never guessed);
//   7. the tool has no connection (no `expect` entry) → undetermined `not_connected` (never a pass);
//   8. a live id the connection does not have → problem `wrong_id` (GA4: a `tid` in no connected stream);
//   9. pass ("delivering" in a real visit).
// Beside the Meta tool, D10: an ADOPTED pixel's automatic events, counted per visit with no clicks, as
// `info`; undetermined (count null, never a measured 0) whenever the pixel itself could not be graded or
// sent nothing at all.
// The facts are THIS run's: a result whose `runId` differs from the caller's run is refused (review
// O6-R19), and every CheckResult carries the facts' own run id.
//
// Incidents guarded here (wf5-PORT-PLAN §4): "Traffic Permissions blocked delivery while every surface
// showed green" (rule 3), "Preview leak" (rule 2), "Sandbox held the production pixel" (rule 6,
// env-dependent, with O9's env-targets check), "Parser folded unreadable into absent" (undetermined is
// never a pass and never an "absent").
import type { CheckResult, CheckTier, EnvSourcedId, Evidence } from "../wizard/contracts/jobs.js"
import type { TestExpect, TestMode, TestResult, TestTool } from "../wizard/contracts/test-engine.js"
import { TEST_BROWSER_UA_PATTERN, TEST_TOOLS } from "../wizard/contracts/test-engine.js"

/**
 * Everything the grader needs beyond the facts (§3z.12 §3e.7, B11: the three context fields are REQUIRED on
 * every call; null = honestly unknown, never guessed). `installedTools` and `consentMode` come from the
 * census, the install and the keys verb / plan answer.
 */
export interface GradeContext {
  cmpDetected: TestResult["environment"]["cmpDetected"]
  envSourcedIds: readonly EnvSourcedId[]
  /** The site's Infinite consent mode. null = unknown (a silent tool then reads `undetermined (test_error)`). */
  consentMode: "required" | "not_required" | null
  /** Tools installed on the site. null = unknown (a no-beacon tool is then undetermined). */
  installedTools: readonly TestTool[] | null
  /** Whose Meta pixel the site runs; D10 counts automatic events for an ADOPTED pixel only. null = none / unknown. */
  metaPixelOwnership: "managed" | "adopted" | null
  /** §3x.3 (F6): the load ran a client-side navigation. */
  spaNavigation?: boolean
  runId?: string | null
  now?: () => Date
}

export interface GradedTestRun {
  tools: Record<TestTool, CheckResult>
  /** D10 (adopted pixels only), else null. `count` = automatic events per visit. */
  metaAutomaticEvents: { result: CheckResult; count: number | null } | null
  /** The derived per-check results (RH / PV / T1 check ids the jobs name), see `gradeTestRunChecks`. */
  checks: CheckResult[]
}

/** Meta's automatic events (fbevents, with autoConfig left on): sent per visit with no clicks. */
export const META_AUTOMATIC_EVENTS = new Set(["Microdata", "SubscribedButtonClick", "InputData"])

const GUARDED_TOOLS: ReadonlySet<TestTool> = new Set(["ga4", "posthog", "meta"])

/** The tier a test run's checks carry: the before-measurement is a live read, then rehearsal, then prove. */
export function tierForMode(mode: TestMode): CheckTier {
  return mode === "rehearsal" ? "RH" : mode === "real_visit" ? "PV" : "T1"
}

function isPreviewSelf(result: TestResult): boolean {
  return result.loads.length > 0 && result.loads.every((load) => load.label === "preview_self")
}

/** The beacons a tool sent from the preview's own URL (every fact carries its load label since §3z.9, A17). */
function previewSelfBeacons(result: TestResult, tool: TestTool): number {
  switch (tool) {
    case "ga4":
      return result.ga4.events.filter((event) => event.loadLabel === "preview_self").length
    case "posthog":
      return result.posthog.events.filter((event) => event.loadLabel === "preview_self").length
    case "meta":
      return result.meta.tr.filter((tr) => tr.loadLabel === "preview_self").length
    case "infinite":
      return result.infinite.events.filter((event) => event.loadLabel === "preview_self").length
  }
}

/** Loads that really rendered a page (2xx/3xx). A page that never ran cannot be graded. */
function renderedLoads(result: TestResult): TestResult["loads"] {
  return result.loads.filter((load) => load.rendered && load.status >= 200 && load.status < 400)
}

/** The build is a preview build: the rehearsal (a preview served under production) or the preview's own URL. */
function isPreviewBuild(result: TestResult, mode: TestMode): boolean {
  return mode === "rehearsal" || isPreviewSelf(result)
}

function beaconCount(result: TestResult, tool: TestTool): number {
  switch (tool) {
    case "ga4":
      return result.ga4.events.length
    case "posthog":
      return result.posthog.events.length
    case "infinite":
      return result.infinite.events.length
    case "meta":
      return result.meta.tr.length
  }
}

/** The ids a tool's beacons carried (GA4 `tid`, PostHog project key, Meta pixel, Infinite site source). */
function beaconIds(result: TestResult, tool: TestTool): string[] {
  switch (tool) {
    case "ga4":
      return result.ga4.events.map((event) => event.tid)
    case "posthog":
      return result.posthog.events.map((event) => event.projectKey)
    case "infinite":
      return result.infinite.events.map((event) => event.siteSourceKey)
    case "meta":
      return result.meta.tr.map((tr) => tr.pixelId)
  }
}

function expectedIds(expect: TestExpect, tool: TestTool): string[] | null {
  switch (tool) {
    case "ga4":
      return expect.ga4 && expect.ga4.length ? expect.ga4 : null
    case "posthog":
      return expect.posthog ? [expect.posthog.projectKey] : null
    case "infinite":
      return expect.infinite ? [expect.infinite.siteSourceKey] : null
    case "meta":
      return expect.meta && expect.meta.length ? expect.meta : null
  }
}

/** Evidence of a client-side route change in this result (the one load may then carry a second page view). */
function spaNavigationSeen(result: TestResult): boolean {
  return result.ga4.events.some((event) => event.afterNav) || result.posthog.events.some((event) => event.afterNav) || result.infinite.events.some((event) => event.nav)
}

function duplicatePageViews(result: TestResult, tool: "ga4" | "posthog"): string[] {
  const counts = new Map<string, number>()
  if (tool === "ga4") {
    for (const event of result.ga4.events) {
      if (event.en !== "page_view") continue
      const key = `${event.loadLabel}|${event.tid}|${event.afterNav ? "nav" : "load"}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return [...counts].filter(([, count]) => count > 1).map(([key, count]) => `${key.split("|")[1]} sent ${count} page_view on ${key.split("|")[0]}`)
  }
  // §3z.9 (A17): PostHog facts carry their load and whether they came after a client-side navigation.
  for (const event of result.posthog.events) {
    if (event.event !== "$pageview") continue
    const key = `${event.loadLabel}|${event.projectKey}|${event.afterNav ? "nav" : "load"}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 1).map(([key, count]) => `${key.split("|")[1]} sent ${count} $pageview on ${key.split("|")[0]}`)
}

function isHttpStatus(status: TestResult["meta"]["tr"][number]["status"]): status is number {
  return typeof status === "number"
}

/** The `<code>` of a `<code> — <detail>` reason (null for a pass). */
function reasonCodeOf(result: CheckResult): string | null {
  if (result.state === "pass" || !result.reason) return null
  return result.reason.split(" — ")[0] ?? null
}

interface Verdict {
  state: CheckResult["state"]
  code: string | null
  detail: string
}

/** §3x.5 The one sentence a non-browser test window gets for every tool. */
export const NOT_A_BROWSER_DETAIL = "the test window did not look like a normal browser, so its silence proves nothing"

/**
 * §3x.3 (F6): an installed Meta pixel that sent its first PageView on load, after a client-side navigation: 0 more
 * PageViews → it counts only the first page of a visit; more than one → doubled. null = not measured / fine.
 */
function metaSpaVerdict(result: TestResult, ctx: GradeContext): Verdict | null {
  if (!ctx.spaNavigation || !(ctx.installedTools ?? []).includes("meta")) return null
  const onLoad = result.meta.tr.filter((tr) => tr.ev === "PageView" && !tr.afterNav)
  if (onLoad.length === 0) return null
  const afterNav = result.meta.tr.filter((tr) => tr.ev === "PageView" && tr.afterNav).length
  if (afterNav === 0) return { state: "problem", code: "meta_spa_page_view_missing", detail: "Meta counts only the first page of a visit (no PageView after the page change)" }
  if (afterNav > 1) return { state: "problem", code: "duplicate_page_view", detail: `Meta sent ${afterNav} PageView after one page change` }
  return null
}

function gradeTool(tool: TestTool, result: TestResult, expect: TestExpect, mode: TestMode, ctx: GradeContext): Verdict {
  const env = result.environment
  if (!TEST_BROWSER_UA_PATTERN.test(env.ua)) return { state: "undetermined", code: "test_error", detail: NOT_A_BROWSER_DETAIL }
  if (env.automationDetected) return { state: "undetermined", code: "automation_detected", detail: "navigator.webdriver was true in the test window" }
  if (env.blockedBySiteBotRules) return { state: "undetermined", code: "blocked_by_site_bot_rules", detail: "the site's bot rules refused the test window" }
  if (env.previewProtected) return { state: "undetermined", code: "preview_protected", detail: "the preview is protected; v1 cannot load it" }
  if (renderedLoads(result).length === 0) {
    const statuses = result.loads.map((load) => `${load.label} ${load.status}${load.rendered ? "" : " (not rendered)"}`).join(", ")
    return { state: "undetermined", code: "test_error", detail: result.loads.length ? `no page loaded (${statuses}), so its tags were never exercised` : "the run loaded no page" }
  }

  const beacons = beaconCount(result, tool)
  if (GUARDED_TOOLS.has(tool) && isPreviewSelf(result)) {
    return beacons > 0
      ? { state: "problem", code: "previews_send_data", detail: `${beacons} ${tool} beacon(s) from the preview's own URL` }
      : { state: "pass", code: null, detail: `${tool} stays silent on the preview` }
  }
  if (GUARDED_TOOLS.has(tool)) {
    const fromPreview = previewSelfBeacons(result, tool)
    if (fromPreview > 0) return { state: "problem", code: "previews_send_data", detail: `${fromPreview} ${tool} beacon(s) from the preview's own URL` }
  }
  if (tool === "meta") {
    if (result.meta.console.includes("traffic_permissions_blocked"))
      return { state: "problem", code: "traffic_permissions_blocked", detail: "Meta's Traffic Permissions refuse this domain, so the pixel is blocked" }
    const rejected = result.meta.tr.filter((tr) => isHttpStatus(tr.status) && tr.status >= 400 && tr.status < 500)
    if (rejected.length) return { state: "problem", code: "meta_tr_rejected", detail: `Meta answered ${rejected.map((tr) => tr.status).join(", ")} to the pixel's /tr` }
  }
  const pii = result.pii.filter((entry) => entry.lane === tool && entry.count > 0)
  if (pii.length) return { state: "problem", code: "no_pii", detail: `${pii.map((entry) => `${entry.count} ${entry.kind}`).join(", ")} in ${tool} requests` }
  if (tool === "ga4" || tool === "posthog") {
    const duplicates = duplicatePageViews(result, tool)
    if (duplicates.length) return { state: "problem", code: "duplicate_page_view", detail: `${duplicates.join("; ")}: every visit is counted twice` }
  }
  if (tool === "meta") {
    const spa = metaSpaVerdict(result, ctx)
    if (spa) return spa
  }
  if (beacons === 0) {
    // The seed writes Infinite's own consent key, which Infinite AND a managed Meta pixel read
    // (providers/meta-browser/consent.ts): for those, a seeded silence is a broken install, not consent.
    const seedReleases = tool === "infinite" || (tool === "meta" && ctx.metaPixelOwnership === "managed")
    const consentRequired = ctx.consentMode === "required" && !(env.consentSeeded && seedReleases)
    const cmp = ctx.cmpDetected ?? env.cmpDetected
    if (consentRequired || cmp !== null)
      return { state: "undetermined", code: "held_by_consent", detail: consentRequired ? "consent is required and the test-only grant had no effect" : `a consent tool (${cmp}) holds it` }
    if (ctx.consentMode === null)
      return { state: "undetermined", code: "test_error", detail: "the site's consent mode is not known, so silence cannot be told from consent" }
    const envSourced = ctx.envSourcedIds.find((entry) => entry.tool === tool)
    if (envSourced && isPreviewBuild(result, mode))
      return { state: "undetermined", code: "env_dependent", detail: `${envSourced.envName} (${envSourced.file}:${envSourced.line}) has no value in a preview build` }
    if (ctx.installedTools === null) return { state: "undetermined", code: "test_error", detail: "the tools installed on the site are not known" }
    if (ctx.installedTools.includes(tool)) return { state: "problem", code: "no_beacon", detail: `${tool} is installed but sent nothing` }
    return { state: "info", code: "not_installed", detail: `${tool} is not on the site` }
  }
  const expected = expectedIds(expect, tool)
  if (!expected) return { state: "undetermined", code: "not_connected", detail: `${tool} fires but has no connection to compare its id with` }
  const wrong = [...new Set(beaconIds(result, tool).filter((id) => !expected.includes(id)))]
  if (wrong.length) return { state: "problem", code: "wrong_id", detail: `${wrong.join(", ")} is not ${tool === "ga4" ? "a stream of the connected property" : "the connected id"}` }
  return mode === "real_visit"
    ? { state: "pass", code: null, detail: `${tool} delivering (seen leaving)` }
    : { state: "pass", code: null, detail: `${tool} fires once with the connected id` }
}

function toResult(checkId: string, verdict: Verdict, tier: CheckTier, ctx: GradeContext, evidence?: Evidence[]): CheckResult {
  return {
    checkId,
    state: verdict.state,
    reason: verdict.code ? `${verdict.code} — ${verdict.detail}` : verdict.detail,
    ...(evidence && evidence.length ? { evidence } : {}),
    tier,
    at: (ctx.now ?? (() => new Date()))().toISOString(),
    runId: ctx.runId ?? null
  }
}

function loadEvidence(result: TestResult): Evidence[] {
  return result.loads.map((load) => ({ url: load.url }))
}

/**
 * B12: the D10 count read back from the ONE result this grader wrote (`before` stores it in before.json's
 * checks; the plan reads it here and never counts `tr` events itself). null = unmeasured ("—", never 0):
 * no such result, or one that is not `info` (blocked, silent, ungraded).
 */
export function automaticEventsPerVisitOf(checks: readonly CheckResult[]): number | null {
  const check = checks.find((entry) => entry.checkId === "meta_automatic_events")
  if (!check || check.state !== "info") return null
  const match = /^meta_automatic_events — (\d+(?:\.\d+)?) automatic event\(s\) per visit/.exec(check.reason ?? "")
  return match ? Number(match[1]) : null
}

/** D10: automatic events of an ADOPTED pixel, per visit, with no clicks. */
function gradeMetaAutomaticEvents(result: TestResult, mode: TestMode, ctx: GradeContext, meta: CheckResult): GradedTestRun["metaAutomaticEvents"] {
  if (ctx.metaPixelOwnership !== "adopted") return null
  const tier = tierForMode(mode)
  if (result.meta.console.includes("traffic_permissions_blocked"))
    return { result: toResult("meta_automatic_events", { state: "undetermined", code: "traffic_permissions_blocked", detail: "the pixel is blocked, so its automatic events cannot be counted" }, tier, ctx), count: null }
  // Unmeasured is "—", never 0 (review O6-R18): no count unless the pixel was graded and really sent.
  if (meta.state === "undetermined")
    return { result: toResult("meta_automatic_events", { state: "undetermined", code: reasonCodeOf(meta) ?? "test_error", detail: "the pixel could not be graded, so its automatic events were not counted" }, tier, ctx), count: null }
  if (result.meta.tr.length === 0)
    return { result: toResult("meta_automatic_events", { state: "undetermined", code: "no_beacon", detail: "the pixel sent nothing, so its automatic events were not counted" }, tier, ctx), count: null }
  const visits = Math.max(1, renderedLoads(result).length)
  const automatic = result.meta.tr.filter((tr) => META_AUTOMATIC_EVENTS.has(tr.ev)).length
  const count = Math.round((automatic / visits) * 10) / 10
  return {
    result: toResult("meta_automatic_events", { state: "info", code: "meta_automatic_events", detail: `${count} automatic event(s) per visit, no clicks` }, tier, ctx, loadEvidence(result)),
    count
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

/**
 * The check ids the job table names for rehearsal / prove (and the before-measurement), derived from the
 * same facts and the per-tool grades: `one_beacon_per_tool`, `ga4_one_page_view`, `meta_pixel_once`,
 * `posthog_via_proxy_once`, `preview_self_silent`, `no_csp_violation`, `no_pii`, `click_test` (one per
 * click, reason `label=<label>; …`), `ga4_seen_leaving` and `meta_seen_leaving` (real visit only).
 */
export function gradeTestRunChecks(result: TestResult, tools: Record<TestTool, CheckResult>, mode: TestMode, ctx: GradeContext): CheckResult[] {
  const tier = tierForMode(mode)
  const out: CheckResult[] = []
  const add = (checkId: string, state: CheckResult["state"], code: string | null, detail: string) =>
    out.push(toResult(checkId, { state, code, detail }, tier, ctx, loadEvidence(result)))
  const blockedBy = (state: CheckResult["state"]) => state === "undetermined"
  const code = (tool: TestTool) => reasonCodeOf(tools[tool])
  // Every derived check reads the FACTS for its own question (review O6-R10): the per-tool verdict is
  // first-match-wins, so a `no_pii` problem would otherwise hide a doubled page view.
  const duplicates = { ga4: duplicatePageViews(result, "ga4"), posthog: duplicatePageViews(result, "posthog") }

  // one_beacon_per_tool: no tool doubled its page views and every installed tool sent something.
  const doubled = (["ga4", "posthog"] as const).filter((tool) => duplicates[tool].length > 0)
  const silent = TEST_TOOLS.filter((tool) => code(tool) === "no_beacon")
  const unknown = TEST_TOOLS.filter((tool) => blockedBy(tools[tool].state))
  if (doubled.length || silent.length)
    add("one_beacon_per_tool", "problem", doubled.length ? "duplicate_page_view" : "no_beacon", [...doubled.map((tool) => `${tool}: ${duplicates[tool].join("; ")}`), ...silent.map((tool) => `${tool}: installed but sent nothing`)].join("; "))
  else if (unknown.length) add("one_beacon_per_tool", "undetermined", "not_exercised", `${unknown.join(", ")} could not be graded`)
  else add("one_beacon_per_tool", "pass", null, "each firing tool sends one page view per load")

  // ga4_one_page_view: exactly one page_view per load, from the facts.
  const ga4PageViews = result.ga4.events.filter((event) => event.en === "page_view").length
  if (duplicates.ga4.length) add("ga4_one_page_view", "problem", "duplicate_page_view", duplicates.ga4.join("; "))
  else if (blockedBy(tools.ga4.state)) add("ga4_one_page_view", "undetermined", code("ga4") ?? "not_exercised", "GA4 could not be graded")
  else if (tools.ga4.state === "info") add("ga4_one_page_view", "info", code("ga4") ?? "not_installed", "GA4 is not on the site")
  else if (isPreviewSelf(result)) add("ga4_one_page_view", "undetermined", "not_exercised", "only the preview's own URL was loaded (GA4 is meant to stay silent there)")
  else if (ga4PageViews === 0) add("ga4_one_page_view", "problem", "no_beacon", code("ga4") === "no_beacon" ? "GA4 is installed but sent nothing" : "GA4 sent events but no page_view")
  else add("ga4_one_page_view", "pass", null, "one GA4 page_view per load")

  // meta_pixel_once: one PageView per load per pixel; fbevents also fires PageView on pushState, so a
  // client-side navigation in the run allows one more (review O6-R11).
  const pageViews = new Map<string, number>()
  for (const tr of result.meta.tr) if (tr.ev === "PageView") pageViews.set(tr.pixelId, (pageViews.get(tr.pixelId) ?? 0) + 1)
  const loads = Math.max(1, renderedLoads(result).length)
  const allowedPageViews = loads + (spaNavigationSeen(result) ? 1 : 0)
  const metaDoubled = [...pageViews].filter(([, count]) => count > allowedPageViews)
  if (blockedBy(tools.meta.state)) add("meta_pixel_once", "undetermined", "not_exercised", "the Meta pixel could not be graded")
  else if (metaDoubled.length) add("meta_pixel_once", "problem", "duplicate_page_view", metaDoubled.map(([pixel, count]) => `${pixel} sent ${count} PageView in ${loads} load(s)`).join("; "))
  else if (pageViews.size === 0) add("meta_pixel_once", tools.meta.state === "problem" ? "problem" : "undetermined", "no_beacon", "no Meta PageView")
  else add("meta_pixel_once", "pass", null, "one PageView per load per pixel")

  // posthog_via_proxy_once: through the same-origin proxy, once per load.
  const posthogEvents = result.posthog.events
  if (blockedBy(tools.posthog.state) || posthogEvents.length === 0) add("posthog_via_proxy_once", "undetermined", "not_exercised", "no PostHog event to inspect")
  else if (posthogEvents.some((event) => !event.sameOrigin)) add("posthog_via_proxy_once", "problem", "not_proxied", "PostHog events go straight to PostHog, so ad blockers drop them")
  else if (duplicates.posthog.length) add("posthog_via_proxy_once", "problem", "duplicate_page_view", duplicates.posthog.join("; "))
  else add("posthog_via_proxy_once", "pass", null, "PostHog goes through the same-origin proxy, once per load")

  const previewLoads = result.loads.filter((load) => load.label === "preview_self")
  if (previewLoads.length === 0) add("preview_self_silent", "undetermined", "not_exercised", "no load of the preview's own URL in this run")
  else {
    const loud = [...GUARDED_TOOLS].filter((tool) => tools[tool].state === "problem" && code(tool) === "previews_send_data")
    const unsure = [...GUARDED_TOOLS].filter((tool) => blockedBy(tools[tool].state))
    if (loud.length) add("preview_self_silent", "problem", "previews_send_data", `${loud.join(", ")} send data from the preview`)
    else if (unsure.length) add("preview_self_silent", "undetermined", code(unsure[0]!) ?? "not_exercised", `${unsure.join(", ")} could not be graded on the preview`)
    else add("preview_self_silent", "pass", null, "GA4, PostHog and Meta stay silent on the preview's own URL")
  }

  if (result.csp.violations.length) add("no_csp_violation", "problem", "csp_violation", result.csp.violations.map((violation) => `${violation.directive} blocked ${violation.blockedHost}`).join("; "))
  else add("no_csp_violation", "pass", null, "no content-security-policy violation")

  const pii = result.pii.filter((entry) => entry.count > 0)
  if (pii.length) add("no_pii", "problem", "no_pii", pii.map((entry) => `${entry.count} ${entry.kind} in ${entry.lane}`).join("; "))
  else add("no_pii", "pass", null, "no email, phone number or name parameter in any request")

  // click_test (RH): the conversion must reach EVERY installed analytics tool that can take it (GA4 and
  // PostHog), because a pass here marks GA4 key events (review O6-R12). Unknown installs → undetermined.
  for (const click of result.clicks) {
    const prefix = `label=${click.label}; `
    // §3z.9 (A17): a target the engine refused to click (a submit control, a consent banner) was not
    // exercised; it is never a missing conversion.
    if (click.refused !== null) {
      add("click_test", "undetermined", "not_exercised", `${prefix}the test window does not click a ${click.refused === "submit_control" ? "submit control" : "consent banner"}`)
      continue
    }
    if (!click.found) {
      add("click_test", "undetermined", "not_exercised", `${prefix}no element matches ${click.selector}`)
      continue
    }
    const standard = click.events.meta.filter((ev) => META_STANDARD_EVENTS.has(ev))
    const fired = [...click.events.ga4, ...click.events.posthog, ...click.events.infinite]
    if (standard.length) {
      add("click_test", "problem", "fbq_standard_on_click", `${prefix}fbq sent ${standard.join(", ")} on a click`)
      continue
    }
    if (ctx.installedTools === null) {
      add("click_test", "undetermined", "test_error", `${prefix}the grader was not told which tools are installed, so it cannot say which must receive ${click.label}`)
      continue
    }
    const required = (["ga4", "posthog"] as const).filter((tool) => ctx.installedTools!.includes(tool))
    if (required.length === 0) {
      add("click_test", "undetermined", "not_exercised", `${prefix}neither GA4 nor PostHog is installed, so no analytics tool can take ${click.label}`)
      continue
    }
    const missing = required.filter((tool) => !click.events[tool].includes(click.label))
    if (missing.length) add("click_test", "problem", "click_test", `${prefix}${missing.join(" and ")} did not receive ${click.label} (the click sent ${fired.length ? fired.join(", ") : "nothing"})`)
    else add("click_test", "pass", null, `${prefix}fires ga4: ${click.events.ga4.join(", ") || "—"} · posthog: ${click.events.posthog.join(", ") || "—"}`)
  }

  if (mode === "real_visit") {
    const ga4Ok = result.ga4.events.some((event) => typeof event.status === "number" && event.status >= 200 && event.status < 300)
    if (blockedBy(tools.ga4.state)) add("ga4_seen_leaving", "undetermined", "not_exercised", "GA4 could not be graded")
    else add("ga4_seen_leaving", ga4Ok ? "pass" : "problem", ga4Ok ? null : "not_seen_leaving", ga4Ok ? "GA4 seen leaving with a 2xx" : "no GA4 beacon left with a 2xx")
    const metaOk = result.meta.tr.some((tr) => typeof tr.status === "number" && tr.status >= 200 && tr.status < 300)
    if (blockedBy(tools.meta.state)) add("meta_seen_leaving", "undetermined", "not_exercised", "the Meta pixel could not be graded")
    else add("meta_seen_leaving", metaOk ? "pass" : "problem", metaOk ? null : "not_seen_leaving", metaOk ? "sent, domain allowed" : "no Meta /tr left with a 2xx")
  }
  return out
}

/** Grade one test run: per tool, the D10 line, and the derived checks. */
export function gradeTestRunFull(result: TestResult, expect: TestExpect, mode: TestMode, callerCtx: GradeContext): GradedTestRun {
  if (result.mode !== mode) throw new Error(`gradeTestRun: the result is a ${result.mode} run, not ${mode}`)
  if (callerCtx.runId && result.runId !== callerCtx.runId)
    throw new Error(`gradeTestRun: the facts belong to run ${result.runId}, not this run (${callerCtx.runId}); stale facts are never this run's proof`)
  // Every result carries the run the FACTS came from.
  const ctx: GradeContext = { ...callerCtx, runId: result.runId }
  const tier = tierForMode(mode)
  const tools = Object.fromEntries(
    TEST_TOOLS.map((tool) => [tool, toResult(`test_run:${tool}`, gradeTool(tool, result, expect, mode, ctx), tier, ctx, loadEvidence(result))])
  ) as Record<TestTool, CheckResult>
  return { tools, metaAutomaticEvents: gradeMetaAutomaticEvents(result, mode, ctx, tools.meta), checks: gradeTestRunChecks(result, tools, mode, ctx) }
}

/** The `CheckRunner.gradeTestRun` shape (§3e.7): the per-tool results only. */
export function gradeTestRun(result: TestResult, expect: TestExpect, mode: TestMode, ctx: GradeContext): Record<TestTool, CheckResult> {
  return gradeTestRunFull(result, expect, mode, ctx).tools
}
