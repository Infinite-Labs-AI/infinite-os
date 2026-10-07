import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, expect, it } from "vitest"
import { sensitivePosthogOptions } from "../install/posthog-sensitive.js"
import { GA4_PAGE_CHANGE_SCRIPT, META_PAGE_CHANGE_SCRIPT, buildBrief } from "../jobs/briefs.js"
import type { BriefFacts } from "../jobs/briefs.js"
import { itemChecksFor } from "../jobs/registry.js"
import { applyResults } from "../jobs/state-machine.js"
import { JOB_IDS, JOB_TABLE, type ChecklistItem, type CheckResult, type JobId } from "../wizard/contracts/jobs.js"
import { jobStaticCheckFunctions } from "./job-static.js"
import { o9CheckFunctions } from "./o9.js"
import { createCheckRunner } from "./registry.js"
import { buildHostGuardExpression } from "../host-guard.js"
import { buildManagedRewritePairs } from "../frameworks/vercel-config.js"

const fixture = join(__dirname, "../../test/wizard/fixture-site")
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function site(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), "approved-job-edits-"))); roots.push(root); cpSync(fixture, root, { recursive: true }); return root }
const ctx = { runId: "approved-edits", now: () => new Date("2026-10-07T09:00:00Z") }
function item(id: string, files: string[]): ChecklistItem {
  const [jobId, target] = id.split(":") as [JobId, string]
  return { id, jobId, n: JOB_TABLE[jobId].n, title: "Approved change", state: "claimed", owner: "agent", allow: { files, create: [] }, trigger: { finding: "Approved change", evidence: [] }, checks: itemChecksFor(jobId, target, "next-app-router") }
}
const facts: BriefFacts = {
  runId: ctx.runId, framework: "next-app-router", packageManager: "npm", router: "app", appRoot: ".",
  connections: { ga4MeasurementIds: ["G-FAKE00001"], posthog: null, metaPixelIds: ["1234567890123456"] },
  helpers: { module: "lib/infinite-analytics.ts" },
  plan: { conversionNames: ["lead"], privacyText: null, lines: [{ id: "sensitive", kind: "sensitive_pages", text: "Off on /login", jobIds: ["posthog_improve:sensitive_pages"], sensitivePaths: ["/login"] }] },
  guardSites: [{ tool: "meta", file: "app/layout.tsx", line: 26, context: "template_literal", publicId: "1234567890123456" }]
}

it("gives sensitive pages its own restrictive brief and the approved paths", () => {
  const brief = buildBrief([item("posthog_improve:sensitive_pages", ["app/providers.tsx"])], facts)
  expect(brief).toContain("sensitivePaths")
  expect(brief).toContain("append")
  expect(brief).not.toContain("Set `api_host: '/ingest'`")
})

it("states the accepted lead success-handler shape in the silent-form brief", () => {
  const job = item("setup_check_fixes:silent_form", ["app/contact/page.tsx"])
  const brief = buildBrief([job], facts)
  expect(job.checks.map(check => `${check.tier}:${check.id}`)).toEqual(["S:setup_rerun_clean"])
  expect(brief).toContain('approvedConversionNames')
  expect(brief).toContain('data-conversion')
  expect(brief).toContain('infiniteTrack')
  expect(brief).toContain('success')
})

it("verifies the prescribed sensitive-page edit on the main fixture", async () => {
  const root = site()
  const file = "app/providers.tsx"
  const before = readFileSync(join(root, file), "utf8")
  const after = before.replace('"https://us.i.posthog.com" }', `"https://us.i.posthog.com", ${sensitivePosthogOptions(before, ["/login"])} }`)
  writeFileSync(join(root, file), after)
  const job = item("posthog_improve:sensitive_pages", [file])
  const run = () => ({ posthogSensitivePaths: ["/login"] })
  const staticFns = jobStaticCheckFunctions({ root, run })
  const o9 = o9CheckFunctions({ root, version: "test", run, readBaseFile: (_root, path) => path === file ? before : null })
  const input = { item: job, root, appRoot: "." }
  const results = [...await o9.posthog_config(input, ctx) as CheckResult[], ...await staticFns.posthog_improve_applied(input, ctx) as CheckResult[]]
  expect(results.map(result => result.state)).toEqual(["pass", "pass"])
  expect(applyResults(job, results, ctx.runId, { budgetLeft: false }).item.state).toBe("waiting_deploy")
})

it("gives Meta navigation a prescribed paste which can be checked before deployment", () => {
  const job = item("meta_improve:spa_page_view", ["app/layout.tsx"])
  const brief = buildBrief([job], facts)
  expect(brief).toContain('pageViewOnPageChange')
  expect(job.checks.some(check => check.tier === "S")).toBe(true)
  expect(itemChecksFor("ga4_improve", "spa_page_view", "next-app-router").some(check => check.tier === "S")).toBe(true)
  expect(GA4_PAGE_CHANGE_SCRIPT).toContain("pageChanged")
})

it.each(["ga4", "meta"] as const)("verifies the supplied %s navigation paste and rejects missing, commented, or misplaced copies", async tool => {
  const root = site()
  const file = "app/layout.tsx"
  const before = readFileSync(join(root, file), "utf8")
  const script = tool === "ga4" ? GA4_PAGE_CHANGE_SCRIPT : META_PAGE_CHANGE_SCRIPT
  const anchor = tool === "ga4" ? "gtag('config', 'G-FAKE00001');" : "fbq('track', 'PageView');"
  const job = item(`${tool}_improve:spa_page_view`, [file])
  const check = jobStaticCheckFunctions({ root, run: () => ({ expect: { ga4: ["G-FAKE00001"] } }) }).spa_page_view_applied
  const input = { item: job, root, appRoot: "." }
  for (const source of [before, before.replace(anchor, `${anchor}\n/*${script}*/`), before.replace(anchor, `${script}\n${anchor}`), before.replace(anchor, `${anchor}\n${script.replace("if (next === last) return;", "")}`)]) {
    writeFileSync(join(root, file), source)
    expect(await check(input, ctx)).toMatchObject([{ state: "problem" }])
  }
  writeFileSync(join(root, file), before.replace(anchor, `${anchor}\n${script}`))
  const results = await check(input, ctx) as CheckResult[]
  expect(results).toMatchObject([{ state: "pass" }])
  expect(applyResults(job, results, ctx.runId, { budgetLeft: false }).item.state).toBe("waiting_deploy")
})

it("the supplied Meta navigation script sends once per changed path and never on its initial load", () => {
  const sent: unknown[][] = []
  const events = new Map<string, () => void>()
  const location = { pathname: "/", search: "" }
  const history = { pushState: () => {}, replaceState: () => {} }
  const window = { fbq: (...args: unknown[]) => sent.push(args), addEventListener: (name: string, fn: () => void) => events.set(name, fn) }
  runInNewContext(META_PAGE_CHANGE_SCRIPT, { window, location, history })
  expect(sent).toEqual([])
  location.pathname = "/pricing"; history.pushState()
  expect(sent).toEqual([["track", "PageView"]])
  history.replaceState()
  expect(sent).toHaveLength(1)
  location.pathname = "/"; events.get("popstate")!()
  expect(sent).toHaveLength(2)
  runInNewContext(META_PAGE_CHANGE_SCRIPT, { window, location, history })
  location.pathname = "/login"; history.pushState()
  expect(sent).toHaveLength(3)
})

// These kinds cannot be exercised as new agent work on the stock main fixture. Keeping the full
// registry in this audit makes a new kind require either a source proof or an explicit limitation.
const fixtureLimits = {
  server_lane_mount: "Next's fresh middleware is installer work; no existing middleware mount needs an agent.",
  unusual_layout: "The fixture has a supported Next app shell and no existing custom Next config.",
  setup_check_fixes: "The stock form contains a password field, so silent_form is not seeded; its provider census duplicates are covered by duplicates_remove.",
  csp: "The stock fixture has no content security policy to amend.",
  redirect_utms: "No redirect owner exists in the fixture. This kind has only live redirect_walk; a local source edit alone cannot be verified.",
  privacy_paragraph: "Retired owner-only work, never agent verification.",
  build_fix: "The stock fixture build is green. A build-fix job needs an introduced failing build.",
  review_comments: "Needs an independently read review finding and later PR checks; local pr_checks_pass deliberately stays undetermined."
} as const
const sourceVerifiedKinds = ["posthog_improve", "ga4_improve", "meta_improve", "duplicates_remove", "preview_guard", "server_conversions", "identify_reset", "conversions_to_tools"]

it("audits every registered kind as source-verifiable on the fixture or names its missing prerequisite", () => {
  expect([...sourceVerifiedKinds, ...Object.keys(fixtureLimits)].sort()).toEqual([...JOB_IDS].sort())
})

it("verifies correct scripted source edits for each applicable kind on the main fixture", async () => {
  const root = site()
  const load = (file: string) => readFileSync(join(root, file), "utf8")
  const edit = (file: string, change: (source: string) => string) => writeFileSync(join(root, file), change(load(file)))
  const provider = "app/providers.tsx"
  const layout = "app/layout.tsx"
  const signup = "app/api/signup/route.ts"
  const login = "app/api/auth/login/route.ts"
  const logout = "app/api/auth/logout/route.ts"
  const form = "app/signup/page.tsx"
  const originals = new Map([provider, layout, signup, login, logout, form].map(file => [file, load(file)]))
  const guard = buildHostGuardExpression({ mode: "deny", exempt: ["fixture.example"], deny: [] })
  const proxy = { posthog: { path: "/ingest", assetsHost: "https://us-assets.i.posthog.com", ingestHost: "https://us.i.posthog.com" } }
  writeFileSync(join(root, "next.config.mjs"), `export default { async rewrites() { return ${JSON.stringify(buildManagedRewritePairs(proxy))}; } }`)
  edit(provider, source => source.replace('api_host: "https://us.i.posthog.com"', `api_host: "/ingest", capture_pageview: "history_change", defaults: "2026-01-30", ${sensitivePosthogOptions(undefined, ["/login"])}`)
    .replace("posthog.init(", `if (${guard}) posthog.init(`))
  edit(layout, source => source.replace('        <Script id="ga4-again" strategy="afterInteractive">\n          {`gtag(\'config\', \'G-FAKE00001\');`}\n        </Script>\n', "")
    .replace("gtag('config', 'G-FAKE00001');", `gtag('config', 'G-FAKE00001');\n${GA4_PAGE_CHANGE_SCRIPT}`)
    .replace("fbq('init', '1234567890123456');", "fbq('set', 'autoConfig', false, '1234567890123456');\nfbq('init', '1234567890123456');")
    .replace("fbq('track', 'PageView');", `fbq('track', 'PageView');\n${META_PAGE_CHANGE_SCRIPT}`))
  edit(signup, source => source.replace("  return Response.json({ ok: true", "  await reportInfiniteOutcome({ type: 'sign_up', path: '/signup', eventId: data.user.id })\n  return Response.json({ ok: true"))
  edit(login, source => source.replace("  return Response.json({ ok: true", "  infiniteIdentify(data.user.id)\n  return Response.json({ ok: true"))
  edit(logout, source => source.replace("  await supabase.auth.signOut()", "  await supabase.auth.signOut()\n  infiniteReset()"))
  edit(form, source => source.replace('if (response.ok) window.location.assign("/")', 'if (response.ok) { infiniteTrack("sign_up"); window.location.assign("/"); }'))
  const run = () => ({ conversionNames: ["sign_up"], posthogSensitivePaths: ["/login"], productionHosts: ["fixture.example"], expectedEmittedGuard: guard, expect: { ga4: ["G-FAKE00001"], meta: ["1234567890123456"] }, proxy })
  const functions = { ...jobStaticCheckFunctions({ root, run }), ...o9CheckFunctions({ root, version: "test", run, readBaseFile: (_root, file) => originals.get(file) ?? null }) }
  const runner = createCheckRunner({ root, appRoot: ".", runId: () => ctx.runId, now: ctx.now })
  const build = await runner.run("build", {})
  const buildResults = Array.isArray(build) ? build : [build]
  expect(buildResults.filter(result => result.state !== "pass")).toEqual([])
  const jobs = [
    item("posthog_improve:proxy", [provider, "next.config.mjs"]), item("posthog_improve:history_change", [provider]), item("posthog_improve:defaults", [provider]), item("posthog_improve:sensitive_pages", [provider]),
    item("ga4_improve:id", [layout]), item("ga4_improve:spa_page_view", [layout]), item("meta_improve:spa_page_view", [layout]), item("meta_improve:autoconfig_off_adopted", [layout]),
    item("duplicates_remove:ga4_config:G-FAKE00001", [layout]), item("preview_guard:posthog", [provider]),
    item("server_conversions:signup", [signup]), item("identify_reset:auth", [login, logout]), item("conversions_to_tools:signup", [form])
  ]
  for (const job of jobs) {
    const results: CheckResult[] = []
    for (const check of job.checks.filter(check => check.tier === "S")) {
      const input = { item: job, root, appRoot: "." }
      const fn = functions[check.id as keyof typeof functions]
      const raw = fn ? await fn(input, ctx) : await runner.run(check.id, input)
      results.push(...(Array.isArray(raw) ? raw : [raw]))
    }
    expect(results.length, job.id).toBeGreaterThan(0)
    expect(results.filter(result => result.state !== "pass"), job.id).toEqual([])
    // The real fixture build and source checks establish local verification. Live tiers remain pending.
    expect(["done_in_code", "waiting_deploy", "waiting_real_event", "proven"], job.id).toContain(applyResults(job, [...results, ...buildResults], ctx.runId, { budgetLeft: false }).item.state)
  }
})
