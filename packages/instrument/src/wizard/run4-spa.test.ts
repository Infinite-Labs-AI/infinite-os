// R4-8 (live run 4), replayed end to end through the wizard's own pieces on run 4's site and `before.json`: GA4 sent
// nothing on the test load's client-side page change (Meta's page-change PageView proved the page changed), the
// headline named "spa page views", and no plan line or job fixed it. Now:
//   Separate-consent world: before facts → a `ga4_improve:spa_page_view` candidate → an excludable plan line → the brief's exact
//   bytes → pasted where the brief says → the page sends ONE page_view per page change → the rehearsal's RH check.
//   Recorded inline-consent world: owner handoff, no executable checks, and the original bytes stay frozen.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { afterEach, describe, expect, it } from "vitest"

import { cleanupSites, fakeHosting, fakeProductionDeniedConflict, IDS, makeSite } from "../../test/wizard/o7-fakes.js"
import { scanResult } from "../../test/wizard/o8/fixtures.js"
import { WizardInstaller } from "../install/installer.js"
import type { WizardBeforeFacts } from "../install/plan-model.js"
import { buildBrief, GA4_PAGE_CHANGE_SCRIPT } from "../jobs/briefs.js"
import { jobScanFrom } from "../jobs/detectors/index.js"
import { briefConnectionsFrom, briefPlanFrom } from "../jobs/plan-data.js"
import { applyApprovalsTo, dryNavigated, requiredLineKind, seedCandidatesFrom } from "../jobs/registry.js"
import { restoreFrozenUnits } from "../jobs/consent-units.js"
import { snapshotFromFiles } from "../jobs/repo-files.js"
import { rehearsalCheckResults, type RehearsalOutcome } from "../review/rehearse.js"
import { cookTemplateLiteral, inlineScriptsOf } from "../t0/inline-scripts.js"
import type { BeforeFacts, BuildResult } from "./contracts/jobs.js"
import { adoptedInitSites } from "./deps.js"
import type { BeforeFactsFile } from "./handoff/before-facts.js"

afterEach(cleanupSites)

const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const before = JSON.parse(readFileSync(join(RUN4, "wizard/before.json"), "utf8")) as BeforeFactsFile
const SPA = "ga4_improve:spa_page_view"

function siteFiles(): Record<string, string> {
  const base = join(RUN4, "site-b7c8347")
  const walk = (at: string): string[] =>
    readdirSync(join(base, at)).flatMap((name) => {
      const rel = at ? `${at}/${name}` : name
      return statSync(join(base, rel)).isDirectory() ? walk(rel) : [rel]
    })
  return Object.fromEntries(walk("").map((rel) => [rel, readFileSync(join(base, rel), "utf8")]))
}

/**
 * The page's own GA4 bytes run in a vm with a History API: returns the `gtag('event', 'page_view')` calls made by the
 * first load, then by a client-side page change, a same-URL replaceState, and the back button.
 */
function pageViews(layout: string): { firstLoad: number; afterPush: number; afterSameReplace: number; afterBack: number } {
  const read = inlineScriptsOf("app/layout.tsx", layout)
  if (!read.ok) throw new Error(read.reason)
  const listeners: Record<string, Array<() => void>> = {}
  const location = { hostname: "shop.examplebrand.com", pathname: "/", search: "", get href() { return `https://shop.examplebrand.com${this.pathname}${this.search}` } }
  const go = (url: string) => {
    const parsed = new URL(url, location.href)
    location.pathname = parsed.pathname
    location.search = parsed.search
  }
  const history = { pushState: (_state: unknown, _title: string, url: string) => go(url), replaceState: (_state: unknown, _title: string, url: string) => go(url) }
  // The vm's global IS the window (a top-level `function gtag` lands on it, as in a browser).
  const sandbox: Record<string, unknown> & { dataLayer: unknown[][]; history: typeof history } = {
    location,
    history,
    document: { title: "Smoke Co." },
    addEventListener: (type: string, listener: () => void) => (listeners[type] ??= []).push(listener),
    dataLayer: []
  }
  sandbox.window = sandbox
  // Every inline GA4 script of the page (the consent default and the config block), as Next would run them.
  for (const script of read.scripts.filter((entry) => /gtag\(/.test(entry.code))) runInNewContext(script.code, sandbox)
  const count = () => sandbox.dataLayer.filter((args) => args[0] === "event" && args[1] === "page_view").length
  const firstLoad = count()
  sandbox.history.pushState(null, "", "/pricing")
  const afterPush = count() - firstLoad
  sandbox.history.replaceState(null, "", "/pricing")
  const afterSameReplace = count() - firstLoad - afterPush
  go("/")
  for (const listener of listeners.popstate ?? []) listener()
  return { firstLoad, afterPush, afterSameReplace, afterBack: count() - firstLoad - afterPush - afterSameReplace }
}

/** The runnable world keeps the recorded consent script verbatim in a separate owner component. */
function consentSeparatedSiteFiles(): Record<string, string> {
  const files = siteFiles()
  const layout = files["app/layout.tsx"]!
  const consent = /<Script id="consent-default"[^>]*>[\s\S]*?<\/Script>/.exec(layout)?.[0]
  if (!consent) throw new Error("Recorded consent-default script is missing")
  files["app/consent-defaults.tsx"] = `import Script from 'next/script'\nexport function ConsentDefaults() { return (${consent}) }\n`
  files["app/layout.tsx"] = `import { ConsentDefaults } from './consent-defaults'\n${layout.replace(consent, "<ConsentDefaults />")}`
  return files
}

describe("run 4 SPA regression with separate recorded-consent and runnable worlds", () => {
  const files = consentSeparatedSiteFiles()
  const scan = () => jobScanFrom(scanResult({ framework: "next-app-router" }), snapshotFromFiles(files))
  const facts = before.facts as unknown as BeforeFacts

  it("leaves the original recorded inline-consent layout as an owner handoff without checks", () => {
    const recorded = siteFiles()
    const layout = recorded["app/layout.tsx"]!
    expect(layout).toContain("gtag('consent', 'default'")
    const recordedScan = jobScanFrom(scanResult({ framework: "next-app-router" }), snapshotFromFiles(recorded))
    const item = seedCandidatesFrom(recordedScan, facts).find(candidate => candidate.id === SPA)!
    expect(item).toMatchObject({ state: "left_for_you", ownerBoundary: { kind: "frozen_unit", file: "app/layout.tsx" }, checks: [] })
    expect(item.note).toContain("Not changed by us:")
    const changed = layout.replace("gtag('config', 'G-QWERT67890');", "gtag('config', 'G-QWERT67890');\n" + GA4_PAGE_CHANGE_SCRIPT)
    const restored = restoreFrozenUnits(layout, changed)
    expect(restored.changes.length).toBeGreaterThan(0)
    expect(restored.text).toBe(layout)
  })

  it("the dry load's page change is seen (Meta sent after it); the run-4 predicate (GA4 or Infinite only) missed it", () => {
    const dry = facts.dryLive!
    expect(dryNavigated(dry)).toBe(true)
    // NEGATIVE: what the seeding read before (no Infinite on the site, and GA4 is the tool that misses page changes).
    expect(dry.ga4.events.some((event) => event.afterNav) || dry.infinite.events.some((event) => event.nav)).toBe(false)
  })

  it("LF4-P3-3 negative: a server redirect (/ → /en) is not a page change; a path change after the landing still is", () => {
    const quiet = structuredClone(facts.dryLive!)
    quiet.ga4.events = quiet.ga4.events.map((event) => ({ ...event, afterNav: false }))
    quiet.posthog.events = quiet.posthog.events.map((event) => ({ ...event, afterNav: false }))
    quiet.meta.tr = quiet.meta.tr.map((tr) => ({ ...tr, afterNav: false }))
    quiet.infinite.events = quiet.infinite.events.map((event) => ({ ...event, nav: false }))
    const load = quiet.loads[0]!
    const origin = new URL(load.url).origin
    quiet.loads = [{ ...load, url: `${origin}/`, finalUrl: `${origin}/en`, redirects: [{ from: `${origin}/`, to: "/en", status: 308 }] }]
    expect(dryNavigated(quiet)).toBe(false)
    quiet.loads = [{ ...load, url: `${origin}/`, finalUrl: `${origin}/en/pricing`, redirects: [{ from: `${origin}/`, to: "/en", status: 308 }] }]
    expect(dryNavigated(quiet)).toBe(true)
    quiet.loads = [{ ...load, url: `${origin}/`, finalUrl: `${origin}/`, redirects: [] }]
    expect(dryNavigated(quiet)).toBe(false)
  })

  it("seeds the runnable job with its own RH checks and an excludable plan line", async () => {
    const candidates = seedCandidatesFrom(scan(), facts)
    const item = candidates.find((candidate) => candidate.id === SPA)
    expect(item).toBeDefined()
    expect(item!.allow.files).toEqual(["app/layout.tsx"])
    expect(item!.checks.map((check) => `${check.tier}:${check.id}`)).toEqual(["RH:ga4_one_page_view", "RH:ga4_spa_page_view", "PV:ga4_seen_leaving"])
    expect(requiredLineKind(item!)).toBe("ga4_spa_page_views")

    const root = makeSite(files)
    const installer = new WizardInstaller({
      repoFingerprint: IDS.fingerprint,
      runId: () => IDS.run,
      agent: () => ({ worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } }),
      consentFlag: () => null,
      productionDeniedConflict: fakeProductionDeniedConflict,
      build: async (): Promise<BuildResult> => ({ ok: true, failureSignature: [], durationMs: 1 })
    })
    const plan = installer.buildPlan(await installer.scan({ root, hosting: fakeHosting() }), before.facts.keys, before.facts as unknown as WizardBeforeFacts, candidates)
    const line = plan.lines.find((entry) => entry.kind === "ga4_spa_page_views")
    expect(line).toMatchObject({ requires: "info", jobIds: [SPA], text: "GA4: send one page_view per page change in your app (today GA4 counts only the first page of each visit)." })
    expect(applyApprovalsTo(candidates, plan, { approved: [line!.id], declined: [], edits: {} }).map((entry) => entry.id)).toContain(SPA)
    // An explicit refusal still excludes the shown repository job.
    expect(applyApprovalsTo(candidates, plan, { approved: [], declined: [line!.id], edits: {} }).map((entry) => entry.id)).not.toContain(SPA)
  })

  it("the brief hands the agent the exact bytes, escaped for the <Script> body, and where; pasted there, the page sends ONE page_view per page change", () => {
    const root = makeSite(files)
    const item = seedCandidatesFrom(scan(), facts).find((candidate) => candidate.id === SPA)!
    const brief = buildBrief([item], {
      runId: IDS.run,
      framework: "next-app-router",
      packageManager: "npm",
      router: "app",
      appRoot: ".",
      plan: { conversionNames: [], privacyText: null, lines: [{ id: "ga4_spa_page_views", kind: "ga4_spa_page_views", text: "GA4: …", jobIds: [SPA] }] },
      connections: briefConnectionsFrom(before.facts.keys),
      guardSites: adoptedInitSites(root, ".")
    })
    const data = JSON.parse(/Plan data \(JSON; decided by the user, use it exactly\): (.*)$/m.exec(brief)![1]!) as { pageViewOnPageChange: { insertAfter: string; pasteAsWritten: string } }
    expect(data.pageViewOnPageChange.insertAfter).toMatch(/^gtag\('config', 'G-QWERT67890'\) at app\/layout\.tsx:\d+$/)
    // The bytes are the script, escaped once for the template literal they go into.
    expect(cookTemplateLiteral(data.pageViewOnPageChange.pasteAsWritten)).toBe(GA4_PAGE_CHANGE_SCRIPT)
    expect(brief).toContain("Here: paste `pageViewOnPageChange.pasteAsWritten` from Plan data exactly")

    // The agent pastes it as the next statement after the FIRST gtag('config', …); (inside the <Script> body).
    const layout = files["app/layout.tsx"]!
    const config = "gtag('config', 'G-QWERT67890');"
    const at = layout.indexOf(config) + config.length
    const fixed = pageViews(`${layout.slice(0, at)}\n${data.pageViewOnPageChange.pasteAsWritten}${layout.slice(at)}`)
    expect(fixed).toEqual({ firstLoad: 0, afterPush: 1, afterSameReplace: 0, afterBack: 1 })
    // NEGATIVE: run 4's layout sends nothing on a page change.
    expect(pageViews(layout).afterPush).toBe(0)
  })

  it("the rehearsal's page change decides it: one GA4 page_view passes; none (run 4) or two is a problem", () => {
    const outcome = (ga4: number | null, meta: number | null): RehearsalOutcome => ({
      state: "graded",
      reason: null,
      previewUrl: null,
      grades: {},
      previewGrades: {},
      clickTested: [],
      ga4ClickTested: [],
      facts: { posthogSameOrigin: null, cspViolations: 0, spaPageViews: { ga4, meta } },
      spaExercised: true
    })
    const check = (ga4: number | null, meta: number | null, id: string) => rehearsalCheckResults(outcome(ga4, meta), { at: "2026-10-03T20:55:55.000Z", runId: IDS.run }).shared.find((result) => result.checkId === id)
    expect(check(1, 1, "ga4_spa_page_view")).toMatchObject({ state: "pass" })
    expect(check(0, 1, "ga4_spa_page_view")).toMatchObject({ state: "problem", reason: "ga4_spa_page_view_missing — no page_view after the page change" })
    expect(check(2, 1, "ga4_spa_page_view")).toMatchObject({ state: "problem", reason: "duplicate_page_view — 2 page_views after one page change" })
    // Meta's SPA half is graded from its own beacons, connected or not (run 4: "not_connected" hid a pass).
    expect(check(0, 1, "meta_spa_page_view")).toMatchObject({ state: "pass" })
    expect(check(null, null, "ga4_spa_page_view")).toBeUndefined()
  })
})
