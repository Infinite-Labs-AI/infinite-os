// The job registry (lane O8): seeding is deterministic and comes only from the wizard's own scan and
// `before` facts; approvals drop declined candidates and park unanswered ones; allowlists never widen
// past the global deny; briefs carry the rules and the evidence; a `not_needed` claim is re-verified.
import { describe, expect, it } from "vitest"

import { beforeFacts, census, fixtureDryLive, RUN_ID, scanResult } from "../../test/wizard/o8/fixtures.js"
import type { PlanLine } from "../wizard/contracts/asks.js"
import type { BeforeFacts, ChecklistItem, CheckResult, PlanModel } from "../wizard/contracts/jobs.js"
import type { TestResult } from "../wizard/contracts/test-engine.js"
import { buildBrief } from "./briefs.js"
import { jobScanFrom } from "./detectors/index.js"
import { snapshotFromFiles } from "./repo-files.js"
import { applyApprovalsTo, createJobRegistry, newlyInstalledTools, requiredLineKind, seedCandidatesFrom } from "./registry.js"

const SITE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", dependencies: { next: "15.0.0" } }),
  "app/layout.tsx": [
    "export default function RootLayout({ children }) {",
    "  return (<html><head>",
    "    <Script id='gtm'>{`(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-FAKE01')`}</Script>",
    "    <Script src='https://www.googletagmanager.com/gtag/js?id=G-FAKE00001' />",
    "    <Script id='ga'>{`gtag('config', 'G-FAKE00001')`}</Script>",
    "  </head><body>{children}</body></html>)",
    "}"
  ].join("\n"),
  "app/providers.tsx": "posthog.init('phc_FAKEtestProjectKeyNotReal000', { api_host: 'https://us.i.posthog.com' })\n",
  "components/pixel.tsx": "fbq('init', '1234567890123456')\nfbq('track', 'PageView')\n",
  "components/cta.tsx": "<button onClick={() => fbq('track', 'Lead')}>Talk to sales</button>\n<a href='/signup'>Sign up</a>\n",
  "lib/fbc.ts": "document.cookie = '_fbc=fb.1.' + Date.now() + '.' + id + '; path=/'\n",
  "app/api/signup/route.ts": "export async function POST(req) {\n  await supabase.auth.signUp({ email, password })\n}\n",
  "app/login/actions.ts": "'use server'\nexport async function login() {\n  await supabase.auth.signInWithPassword({ email, password })\n}\n",
  "components/user-menu.tsx": "onClick={() => supabase.auth.signOut()}\n",
  "app/privacy/page.tsx": "<p>We use Google Analytics.</p>\n",
  "next.config.mjs": "export default { async headers() { return [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: \"script-src 'self'\" }] }] } }\n",
  "components/cookie-banner.tsx": "export function CookieBanner() {}\n",
  "tests/logout.test.ts": "await signOut()\n"
}

const CENSUS = census([
  { tool: "ga4", kind: "gtm", id: "GTM-FAKE01", file: "app/layout.tsx", line: 3 },
  { tool: "ga4", kind: "gtag_config", id: "G-FAKE00001", file: "app/layout.tsx", line: 5 },
  { tool: "posthog", kind: "posthog_init", id: "phc_FAKEtestProjectKeyNotReal000", file: "app/providers.tsx", line: 1 },
  { tool: "meta", kind: "fbq_init", id: "1234567890123456", file: "components/pixel.tsx", line: 1 }
])

function dryWithTwoPageViews(): TestResult {
  const dry = fixtureDryLive()
  dry.ga4.events = [dry.ga4.events[0]!, { ...dry.ga4.events[0]! }]
  return dry
}

const AT = "2026-10-02T09:12:00.000Z"
const check = (checkId: string, tier: CheckResult["tier"], state: CheckResult["state"], extra: Partial<CheckResult> = {}): CheckResult => ({ checkId, tier, state, at: AT, runId: RUN_ID, ...extra })

function facts(overrides: Partial<BeforeFacts> = {}): BeforeFacts {
  return beforeFacts({
    census: CENSUS,
    dryLive: dryWithTwoPageViews(),
    checks: [
      check("csp_header", "T1", "problem", { reason: "script-src blocks www.googletagmanager.com", evidence: [{ url: "https://acme-store.com/" }] }),
      check("conversion_placement", "S", "problem", { reason: "data-conversion on a wrapper div", evidence: [{ file: "components/cta.tsx", line: 1 }] })
    ],
    ...overrides
  })
}

const scanOf = (files: Record<string, string> = SITE, framework = "next-app-router") => jobScanFrom(scanResult({ framework }), snapshotFromFiles(files))

describe("seedCandidates", () => {
  it("seeds every triggered job from the scan and the before facts", () => {
    const items = seedCandidatesFrom(scanOf(), facts())
    expect(items.map((item) => [item.id, item.state, item.blockedReason ?? null])).toEqual([
      ["posthog_improve:history_change", "pending", null],
      ["posthog_improve:proxy", "pending", null],
      ["meta_improve:mirror", "pending", null],
      ["meta_improve:retire_fbc_writer", "pending", null],
      ["duplicates_remove:ga4_gtag", "pending", null],
      ["preview_guard:ga4", "pending", null],
      ["preview_guard:meta", "pending", null],
      ["preview_guard:posthog", "pending", null],
      ["server_conversions:signup", "pending", null],
      ["identify_reset:auth", "pending", null],
      ["conversions_to_tools:signup", "pending", null],
      ["setup_check_fixes:conversion_placement", "pending", null],
      ["csp:next_config_mjs", "pending", null],
      ["privacy_paragraph:page", "pending", null]
    ])
    const identify = items.find((item) => item.id === "identify_reset:auth")!
    // The signOut in a test file is ignored; the CMP file is never allowed.
    expect(identify.allow.files).toEqual(["app/login/actions.ts", "components/user-menu.tsx"])
    // A Next.js site click-tests in the rehearsal (RH), never offline.
    expect(items.find((item) => item.id === "conversions_to_tools:signup")!.checks.map((c) => `${c.tier}:${c.id}`)).toEqual(["RH:click_test", "S:no_fbq_standard_on_click"])
    expect(items.every((item) => item.owner === "agent" && item.checks.every((c) => c.state === "not_run"))).toBe(true)
  })

  it("is deterministic: the same input (in any file order) gives the same items", () => {
    const shuffled = Object.fromEntries(Object.entries(SITE).reverse())
    expect(seedCandidatesFrom(scanOf(shuffled), facts())).toEqual(seedCandidatesFrom(scanOf(), facts()))
  })

  it("decides job 6's GTM + gtag duplicate from before's dry_live only (negative: one page view, or no dry load)", () => {
    const ids = (dry: TestResult | null) => seedCandidatesFrom(scanOf(), facts({ dryLive: dry })).map((item) => item.id)
    expect(ids(dryWithTwoPageViews())).toContain("duplicates_remove:ga4_gtag")
    expect(ids(fixtureDryLive())).not.toContain("duplicates_remove:ga4_gtag")
    expect(ids(null)).not.toContain("duplicates_remove:ga4_gtag")
  })

  it("never turns an undetermined (held by consent) check into a job", () => {
    const held = facts({
      checks: [
        check("meta", "T1", "undetermined", { reason: "held_by_consent" }),
        check("conversion_placement", "S", "undetermined", { reason: "held_by_consent", evidence: [{ file: "components/cta.tsx", line: 1 }] }),
        check("csp_header", "T1", "undetermined", { reason: "held_by_consent" })
      ]
    })
    const ids = seedCandidatesFrom(scanOf(), held).map((item) => item.id)
    expect(ids.some((id) => id.startsWith("setup_check_fixes") || id.startsWith("csp:"))).toBe(false)
  })

  it("parks a nonce / strict-dynamic CSP for the user, and a CSP that is not in the repo", () => {
    const nonce = { ...SITE, "next.config.mjs": "headers: [{ key: 'Content-Security-Policy', value: `script-src 'nonce-${n}' 'strict-dynamic'` }]\n" }
    expect(seedCandidatesFrom(scanOf(nonce), facts()).find((item) => item.jobId === "csp")).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    const { "next.config.mjs": _drop, ...noCsp } = SITE
    expect(seedCandidatesFrom(scanOf(noCsp), facts()).find((item) => item.jobId === "csp")).toMatchObject({ id: "csp:host_config", state: "blocked", allow: { files: [] } })
  })

  it("never puts a denied path in an allowlist, even when the evidence names one", () => {
    const builder = { "astro.config.mjs": "export default {}\n", "package.json": "{}", "src/layouts/Base.astro": "<html></html>" }
    const items = seedCandidatesFrom(scanOf(builder, "unsupported"), beforeFacts())
    for (const item of items) {
      for (const file of [...item.allow.files, ...item.allow.create]) {
        expect(file).not.toMatch(/(^|\/)(package\.json|\.env|pnpm-lock\.yaml|dist\/|\.next\/|node_modules\/)/)
      }
    }
    expect(items.find((item) => item.id === "unusual_layout:custom_builder")?.allow.files).toEqual(["astro.config.mjs"])
  })

  it("names the plan line kind each candidate needs", () => {
    const kinds = Object.fromEntries(seedCandidatesFrom(scanOf(), facts()).map((item) => [item.id, requiredLineKind(item)]))
    expect(kinds).toMatchObject({
      "posthog_improve:proxy": "improve_additive",
      "meta_improve:mirror": "improve_additive",
      "meta_improve:retire_fbc_writer": "retire_fbc_writer",
      "duplicates_remove:ga4_gtag": "remove_duplicate",
      "preview_guard:meta": "preview_guard_adopted",
      "server_conversions:signup": "conversion_names",
      "conversions_to_tools:signup": "conversion_names",
      "privacy_paragraph:page": "privacy_text",
      "identify_reset:auth": null,
      "csp:next_config_mjs": null
    })
  })

  it("counts newly installed tools from the connections minus the census", () => {
    expect(newlyInstalledTools(facts())).toEqual(["infinite"])
    expect(newlyInstalledTools(facts({ census: census([]) }))).toEqual(["infinite", "ga4", "posthog", "meta"])
  })
})

describe("applyApprovals", () => {
  const candidates = seedCandidatesFrom(scanOf(), facts())
  const line = (id: string, kind: PlanLine["kind"], jobIds: string[]): PlanLine => ({ id, kind, text: id, requires: "approval", editable: false, jobIds })
  const plan = (lines: PlanLine[]): PlanModel => ({ hash: "sha256:0", lines, decisions: { consentMode: "not_required", conversionNames: ["signup"], privacyText: null, npmInstall: null } })

  it("drops a declined line's candidates (negative: a declined remove_duplicate seeds no job 6)", () => {
    const lines = [line("remove_duplicate:ga4_gtag", "remove_duplicate", ["duplicates_remove:ga4_gtag"])]
    const declined = applyApprovalsTo(candidates, plan(lines), { approved: [], declined: ["remove_duplicate:ga4_gtag"], edits: {} })
    expect(declined.some((item) => item.jobId === "duplicates_remove")).toBe(false)
    const approved = applyApprovalsTo(candidates, plan(lines), { approved: ["remove_duplicate:ga4_gtag"], declined: [], edits: {} })
    expect(approved.find((item) => item.jobId === "duplicates_remove")?.state).toBe("pending")
  })

  it("never seeds an adopted-provider job without its line, and parks an unanswered one", () => {
    const lines = [line("improve_additive:posthog_proxy", "improve_additive", ["posthog_improve:proxy"])]
    const unanswered = applyApprovalsTo(candidates, plan(lines), { approved: [], declined: [], edits: {} })
    expect(unanswered.find((item) => item.id === "posthog_improve:proxy")).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    // No line names these: never seeded.
    expect(unanswered.some((item) => item.id === "posthog_improve:history_change" || item.id === "preview_guard:meta" || item.jobId === "server_conversions")).toBe(false)
    // A line of the WRONG kind does not count as approval.
    const wrongKind = [line("user_action:x", "user_action", ["preview_guard:meta"])]
    expect(applyApprovalsTo(candidates, plan(wrongKind), { approved: ["user_action:x"], declined: [], edits: {} }).some((item) => item.id === "preview_guard:meta")).toBe(false)
  })

  it("keeps jobs that need no line, unless a line naming them is declined", () => {
    const kept = applyApprovalsTo(candidates, plan([]), { approved: [], declined: [], edits: {} })
    expect(kept.map((item) => item.id)).toEqual(["identify_reset:auth", "setup_check_fixes:conversion_placement", "csp:next_config_mjs"])
    const declined = applyApprovalsTo(candidates, plan([line("identify:x", "improve_additive", ["identify_reset:auth"])]), { approved: [], declined: ["identify:x"], edits: {} })
    expect(declined.some((item) => item.id === "identify_reset:auth")).toBe(false)
  })

  it("does not mutate the candidates", () => {
    const before = JSON.stringify(candidates)
    applyApprovalsTo(candidates, plan([line("improve_additive:posthog_proxy", "improve_additive", ["posthog_improve:proxy"])]), { approved: [], declined: [], edits: {} })
    expect(JSON.stringify(candidates)).toBe(before)
  })
})

describe("the registry object", () => {
  const facts0 = { runId: RUN_ID, framework: "next-app-router", packageManager: "pnpm", router: "app" as const, appRoot: "." }
  const registry = createJobRegistry({ briefFacts: () => facts0 })
  const items = seedCandidatesFrom(scanOf(), facts())

  it("refuses a bare ScanResult (the detections must come from the wizard's own scan)", () => {
    expect(() => registry.seedCandidates(scanResult(), facts())).toThrow(/JobScan/)
    expect(registry.seedCandidates(scanOf(), facts())).toEqual(items)
  })

  it("re-filters allowlists through the global deny", () => {
    const widened: ChecklistItem = { ...items[0]!, allow: { files: ["app/layout.tsx", ".env.local", "package.json", "dist/x.js"], create: ["pnpm-lock.yaml"] } }
    expect(registry.allowedFiles(widened)).toEqual({ files: ["app/layout.tsx"], create: [] })
  })

  it("briefs the agent jobs with the run id, the never-list, the evidence and the allowed files", () => {
    const brief = registry.brief(items)
    expect(brief).toContain(`run ${RUN_ID}`)
    expect(brief).toContain("Never call `fbq('track', <standard event>)` on a click.")
    expect(brief).toContain("Never read `.env` files or anything outside this repository.")
    expect(brief).toContain("### Job identify_reset:auth (9. Join visits to accounts)")
    expect(brief).toContain("Allowed files: app/login/actions.ts, components/user-menu.tsx")
    expect(brief).toContain("  - app/login/actions.ts:3")
    expect(brief).toContain("framework next-app-router, app router, package manager pnpm")
    // The brief never calls a job verified (only a "VERIFIED login" is named as the trigger for identify).
    expect(brief.replace(/a VERIFIED login/g, "")).not.toMatch(/\bverified\b/i)
    expect(brief).toContain("Here: retire the hand-written `_fbc` writer")
    // Negatives: code jobs are never briefed; no brief without a run.
    const code: ChecklistItem = { ...items[0]!, id: "ga4_key_events:signup", jobId: "ga4_key_events", owner: "code" }
    expect(buildBrief([code], facts0)).not.toContain("ga4_key_events:signup")
    expect(() => createJobRegistry({ briefFacts: () => null }).brief(items)).toThrow(/run's brief facts/)
  })

  it("lists an item's checks by tier and applies this run's results", () => {
    const posthog = items.find((item) => item.id === "posthog_improve:proxy")!
    expect(registry.checksFor(posthog, "S")).toEqual([
      { tier: "S", checkId: "posthog_config" },
      { tier: "S", checkId: "next_rewrites_exact" }
    ])
    const claimed = { ...posthog, state: "claimed" as const }
    const [next] = registry.apply([claimed], [check("posthog_config", "S", "pass"), check("next_rewrites_exact", "S", "pass")], RUN_ID)
    expect(next!.state).toBe("waiting_deploy")
  })

  it("re-verifies not_needed against the fresh tree: agrees only when the trigger is gone", () => {
    const identify = items.find((item) => item.id === "identify_reset:auth")!
    expect(registry.reverifyNotNeeded(identify, scanOf())).toEqual({ agrees: false, evidence: [{ file: "app/login/actions.ts", line: 3 }] })
    const { "app/login/actions.ts": _login, ...noLogin } = SITE
    expect(registry.reverifyNotNeeded(identify, scanOf(noLogin))).toEqual({ agrees: true, evidence: [] })
    // A live-triggered job is never agreed statically.
    const csp = items.find((item) => item.jobId === "csp")!
    expect(registry.reverifyNotNeeded(csp, scanOf({})).agrees).toBe(false)
    expect(() => registry.reverifyNotNeeded(identify, scanResult())).toThrow(/JobScan/)
  })
})
