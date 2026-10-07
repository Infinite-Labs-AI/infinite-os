// R4-5 (live run 4): Codex's five findings on PR #5, triaged as the wizard now does. Run 4 handed F3, F4 and F5 to
// Claude Code as FIX; it spent its whole round looking for code it may not change ("Not fixed: the agent ran out of its
// 5 minutes"). Each is now decided before any agent sees it, with the real reason; a real customer-code finding is
// still a FIX. The finding texts are Codex's, verbatim (`pr5-review-inline-comments.md`).
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"

import { cleanupFixtures, installFixture } from "../../test/site-code/install-fixture.js"
import { escapeRegExp } from "../text-escape.js"
import { runtimeExportedNames, runtimeInternalNames } from "./ownership.js"
import { fileRoleOf, infiniteDesignAsk, pageHelperCalls, triage, type TriageContext, type TriageItem } from "./triage.js"

afterAll(cleanupFixtures)

// LF4-P1-3: routing reads the CODE — the run's installed runtime (Infinite's real managed module with the helpers, as
// run 4 had) and the finding's own file at the head (run 4's merged files) — never a keyword list.
const RUN4 = join(__dirname, "../../test/wizard/fixtures/run4")
const HEAD_FILES: Record<string, string> = {
  "app/layout.tsx": readFileSync(join(RUN4, "merged-5e6f3f3/app/layout.tsx"), "utf8"),
  "app/signup/page.tsx": readFileSync(join(RUN4, "merged-5e6f3f3/app/signup/page.tsx"), "utf8"),
  "app/api/signup/route.ts": readFileSync(join(RUN4, "site-b7c8347/app/api/signup/route.ts"), "utf8")
}
const runtime = installFixture("next-app-router-basic", { ga4: { measurementId: "G-QWERT67890" }, conversions: { helpers: true } })
const RUNTIME_SOURCES = [runtime.read("lib/infinite-analytics.ts"), runtime.read("lib/infinite-analytics-client.tsx")]
const INTERNALS = runtimeInternalNames(RUNTIME_SOURCES)
const EXPORTS = runtimeExportedNames(RUNTIME_SOURCES)
const callsIn = (files: Record<string, string>) => (path: string) => (files[path] === undefined ? [] : pageHelperCalls(files[path]!, EXPORTS))
const internalsIn = (files: Record<string, string>) => (text: string, path: string | null) =>
  [...INTERNALS].filter((name) => {
    const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`)
    const own = path === null ? undefined : files[path]
    return pattern.test(text) && !(own !== undefined && pattern.test(own))
  })

const F3 = {
  item: "R9",
  path: "app/layout.tsx",
  line: 61,
  body: "This is the only Meta PageView call, and the root Script does not rerun on Next.js Link navigation. The managed history listener emits only Infinite's site_page_view. Navigating from home to pricing to signup therefore produces no additional Meta page views.",
  suggestedFix: "Add a production-guarded route-change PageView for the existing pixel, with initial-load deduplication so the bootstrap and navigation hook cannot double count."
} as const
const F4 = {
  item: "R16",
  path: "app/signup/page.tsx",
  line: 19,
  body: "infiniteTrackThenNavigate sends the signup event only through GA4/PostHog. It never calls Infinite's collector, while the native runtime emits only page views and click/submit intent events. Successful account creation consequently produces no approved signup outcome in the connected Infinite lane.",
  suggestedFix: "Use a supported Infinite success-event path after response.ok, keeping the approved signup outcome separate from click intent."
} as const
const F5 = {
  item: "R16",
  path: "app/layout.tsx",
  line: 29,
  body: "The adopted GA4 configuration never sets window.__infiniteGa4Lane, and nothing else in the checkout sets it. The signup helper therefore always takes its unstarted-lane branch: it queues gtag('event', 'signup') and immediately calls location.assign. Its event_callback and bounded wait never execute, so navigation can abandon the conversion before dispatch.",
  suggestedFix: "Initialize the connected GA4 lane inside the production-only configuration branch, or explicitly wait for the adopted tag's event callback with a bounded navigation fallback."
} as const

const finding = (input: { item: string; path: string; line: number; body: string; suggestedFix: string }): TriageItem => ({
  source: "reviewer", category: "analytics",
  threadId: null,
  findingId: null,
  item: input.item as TriageItem["item"],
  severity: "should",
  path: input.path,
  line: input.line,
  body: input.body,
  suggestedFix: input.suggestedFix
})

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  allowlist: ["app/layout.tsx", "app/signup/page.tsx"],
  declinedKeys: new Set(),
  // Run 4's rehearsal of 5e6f3f3: Meta sent ONE PageView after the page change; GA4 sent none.
  passingChecks: new Set(["meta_spa_page_view", "adopted_init_guarded", "preview_self_silent"]),
  answerFor: () => null,
  serverLaneInstalled: false,
  infiniteInternalsIn: internalsIn(HEAD_FILES),
  fileRole: (path) => (HEAD_FILES[path] === undefined ? null : fileRoleOf(path, HEAD_FILES[path]!)),
  pageHelperCallsIn: callsIn(HEAD_FILES),
  ...over
})

describe("R4-5: live run 4's findings never reach an agent that cannot fix them", () => {
  it("F3 (R9, 'Meta lacks SPA page views') is declined by the rehearsal's own Meta page-change check", () => {
    const [decision] = triage([finding(F3)], ctx())
    expect(decision).toMatchObject({ action: "DECLINE" })
    expect(decision!.reason).toContain("meta_spa_page_view")
  })

  it("F4 ('the signup never reaches Infinite's collector', on the helper's call) is ASKED with the real reason, naming the missing server lane; never declined on its words", () => {
    const [decision] = triage([finding(F4)], ctx())
    expect(decision).toEqual({ item: expect.anything(), action: "ASK", askReason: "infinite_design", reason: infiniteDesignAsk(false), rule: expect.stringContaining("Infinite counts a conversion from your server") })
    expect(decision!.reason).toContain("never from the page")
    expect(decision!.reason).toContain("connect your Vercel project in Infinite")
    expect(decision!.reason).not.toMatch(/^Not changed/)
  })

  it("F5 (Infinite's helper never waits for an adopted GA4) is Infinite's own code, never the agent's", () => {
    const [decision] = triage([finding(F5)], ctx())
    expect(decision).toMatchObject({ action: "INFINITE", label: "Infinite's own code" })
    expect(decision!.reason).toContain("__infiniteGa4Lane")
  })

  it("negative: a GA4 page-change finding is NOT declined by Meta's passing check (each tool's own check decides)", () => {
    const ga4 = finding({ ...F3, body: "GA4 sends no page_view when the Next.js router changes page; only the first page of a visit is counted.", suggestedFix: "Send a page_view from the router's navigation hook." })
    expect(triage([ga4], ctx())[0]).toMatchObject({ action: "FIX" })
    expect(triage([ga4], ctx({ passingChecks: new Set(["ga4_spa_page_view"]) }))[0]).toMatchObject({ action: "DECLINE" })
  })

  it("negative: a real finding on the customer's own call is still a FIX", () => {
    const real = finding({ ...F4, body: "infiniteTrackThenNavigate is called before the response is checked, so a failed signup is counted as a signup.", suggestedFix: "Move the call inside the response.ok branch." })
    expect(triage([real], ctx())[0]).toMatchObject({ action: "FIX" })
  })

  it("LF4-P1-3 negative: a call-site bug that merely names lib/infinite-analytics is the customer's FIX, never 'Infinite's own code'", () => {
    const callSite = finding({
      item: "R16",
      path: "app/signup/page.tsx",
      line: 19,
      body: "app/signup/page.tsx imports infiniteTrackThenNavigate from lib/infinite-analytics but calls it before response.ok is checked, so a failed signup is counted.",
      suggestedFix: "Move the call from lib/infinite-analytics-client inside the response.ok branch."
    })
    expect(triage([callSite], ctx())[0]).toMatchObject({ action: "FIX" })
  })

  it("LF4-P1-3 negative: a real server-lane bug (the route never reports the signup to Infinite's ledger) is a FIX, never declined as 'by design'", () => {
    const server = finding({
      item: "R16",
      path: "app/api/signup/route.ts",
      line: 8,
      body: "The signup route returns 200 but never reports the signup to Infinite's ledger: it does not call reportInfiniteOutcome, and the client helper only reaches GA4 and PostHog.",
      suggestedFix: "Call reportInfiniteOutcome after the account is created."
    })
    const decided = triage([server], ctx({ allowlist: ["app/layout.tsx", "app/signup/page.tsx", "app/api/signup/route.ts"] }))[0]!
    expect(decided.action).toBe("FIX")
    expect(decided.reason).not.toContain("never from the page")
    // An R10 (server lane) finding on a page file is not declined by the page rule either.
    const r10 = finding({ ...F4, item: "R10" })
    expect(triage([r10], ctx())[0]!.action).not.toBe("DECLINE")
  })

  it("LF4-P1-3: the internals are derived from Infinite's runtime bytes — its private global is one, an exported helper is not", () => {
    expect(INTERNALS.has("__infiniteGa4Lane")).toBe(true)
    expect(INTERNALS.has("infiniteTrackThenNavigate")).toBe(false)
    expect(INTERNALS.has("installInfiniteInstrumentation")).toBe(false)
    expect(EXPORTS.has("infiniteTrackThenNavigate")).toBe(true)
  })

  it("LF4-P1-3 round 1 negative: generic names the runtime happens to declare are never 'Infinite's internals' (only its own infinite… namespace is)", () => {
    // The verifier's list: each is a local of Infinite's runtime AND a word any site's code uses.
    for (const generic of ["userAgent", "hasValue", "cleanValue", "budgetMs", "BUDGET_MS", "OWN_HOSTS", "COOKIE_MAX_AGE", "bootstrapSource", "waitForRequest", "anchorTo"]) {
      expect(INTERNALS.has(generic), generic).toBe(false)
    }
    for (const name of INTERNALS) expect(name, name).toMatch(/^(?:__infinite|infinite|INFINITE_)/)
    expect(INTERNALS.size).toBeGreaterThan(3)
  })

  it("LF4-P1-3: the file's role comes from its contents — the merged signup page is a client file, the signup route a server file", () => {
    expect(fileRoleOf("app/signup/page.tsx", HEAD_FILES["app/signup/page.tsx"]!)).toBe("client")
    expect(fileRoleOf("app/api/signup/route.ts", HEAD_FILES["app/api/signup/route.ts"]!)).toBe("server")
    expect(fileRoleOf("app/actions.ts", '"use server"\nexport async function signUp() {}\n')).toBe("server")
    // A server component page (no directive) is neither: the page rule never declines on it.
    expect(fileRoleOf("app/pricing/page.tsx", "export default function Pricing() { return null }\n")).toBe("other")
    // The directive is found past leading comments, and only as the file's first statement.
    expect(fileRoleOf("app/form.tsx", "// form\n/* the signup form */\n'use client'\nexport default function F() {}\n")).toBe("client")
    expect(fileRoleOf("app/form.tsx", 'import x from "x"\n"use client"\n')).toBe("other")
    // A long run of comment openers is read in linear time (no backtracking), and holds no directive.
    expect(fileRoleOf("app/odd.ts", `/*${"*//*".repeat(50_000)}`)).toBe("other")
  })

  it("LF4-P1-3 negative: F4's words on a SERVER COMPONENT page (no 'use client') are not declined as the page helpers' design", () => {
    const files: Record<string, string> = { ...HEAD_FILES, "app/signup/page.tsx": HEAD_FILES["app/signup/page.tsx"]!.replace('"use client"\n', "") }
    const decided = triage([finding(F4)], ctx({ fileRole: (path) => (files[path] === undefined ? null : fileRoleOf(path, files[path]!)) }))[0]!
    expect(decided.action).not.toBe("DECLINE")
  })

  it("LF4-P1-3 negative: a customer file that itself uses a name Infinite's runtime also uses is the customer's to change", () => {
    const files: Record<string, string> = { ...HEAD_FILES, "app/layout.tsx": `${HEAD_FILES["app/layout.tsx"]}\n// window.__infiniteGa4Lane = { id: "G-QWERT67890" }\n` }
    const decided = triage([finding(F5)], ctx({ infiniteInternalsIn: internalsIn(files) }))[0]!
    expect(decided.action).not.toBe("INFINITE")
  })

  // LF4-P1-3 round 1: the verifier's repro (zz-lf4v-triage), asserted. Before the fix the page-conversion keyword rule ran
  // BEFORE ownership and declined page-view bugs in customer files as "Infinite's design", and a generic runtime local
  // (`userAgent`) routed a customer-route finding to Infinite.
  describe("round 1: ownership first; by-design only for the page helper's conversion", () => {
    const providers =
      '"use client"\nimport { useEffect, useState } from "react"\nimport { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"\nexport function Providers({ children }: { children: React.ReactNode }) {\n  const [ready, setReady] = useState(false)\n  useEffect(() => { const t = setTimeout(() => setReady(true), 3000); return () => clearTimeout(t) }, [])\n  return <>{ready ? <InfiniteAnalyticsClient /> : null}{children}</>\n}\n'
    const files: Record<string, string> = { ...HEAD_FILES, "app/providers.tsx": providers }
    const wide = ctx({
      allowlist: ["app/layout.tsx", "app/signup/page.tsx", "app/api/signup/route.ts", "app/providers.tsx"],
      infiniteInternalsIn: internalsIn(files),
      fileRole: (path) => (files[path] === undefined ? null : fileRoleOf(path, files[path]!)),
      pageHelperCallsIn: callsIn(files)
    })
    const decide = (input: Parameters<typeof finding>[0]) => triage([finding(input)], wide)[0]!

    it("a page view lost to location.assign on the helper's call line is never declined as the conversion design: the user decides", () => {
      const decided = decide({ item: "R3", path: "app/signup/page.tsx", line: 19, body: "This page calls location.assign inside the submit handler before Next has rendered the account page, so the page view for /account never reaches Infinite's ledger: the full reload drops the pending beacon.", suggestedFix: "Use router.push instead of location.assign." })
      expect(decided).toMatchObject({ action: "ASK", askReason: "infinite_design" })
      // The same finding on a line that is not the helper's call is the customer's FIX.
      expect(decide({ item: "R3", path: "app/signup/page.tsx", line: 12, body: "This page calls location.assign inside the submit handler before Next has rendered the account page, so the page view for /account never reaches Infinite's ledger: the full reload drops the pending beacon.", suggestedFix: "Use router.push instead of location.assign." })).toMatchObject({ action: "FIX", reason: "In scope and inside the allowlist." })
    })

    it("a client component mounted late in the customer's providers is the customer's FIX (its first page view never reaches Infinite's collector)", () => {
      const decided = decide({ item: "R3", path: "app/providers.tsx", line: 7, body: "InfiniteAnalyticsClient is mounted only after a 3-second timer, so a visitor who leaves within 3 s sends no page view: the first page view of short visits never reaches Infinite's collector.", suggestedFix: "Render <InfiniteAnalyticsClient /> unconditionally." })
      expect(decided.action).toBe("FIX")
    })

    it("a finding that names only a generic word the runtime also declares (userAgent) is never Infinite's code", () => {
      const decided = decide({ item: "R16", path: "app/signup/page.tsx", line: 19, body: "The signup POST goes to app/api/signup/route.ts, whose bot filter rejects any request whose userAgent contains 'Mozilla/5.0 (X11', so Linux visitors can never sign up and the conversion is lost.", suggestedFix: "Drop the userAgent filter in the route." })
      expect(decided.action).not.toBe("INFINITE")
      expect(decided.action).toBe("FIX")
    })

    it("server-lane and call-site findings stay FIX", () => {
      expect(decide({ item: "R10", path: "app/api/signup/route.ts", line: 8, body: "reportInfiniteOutcome is not awaited, so the serverless function can end before the outcome request completes.", suggestedFix: "await reportInfiniteOutcome(...)" }).action).toBe("FIX")
      expect(decide({ item: "R16", path: "app/signup/page.tsx", line: 19, body: "The handler awaits fetch but never checks response.ok before infiniteTrackThenNavigate; on a 500 it still navigates, and Infinite's queueBeacon then reports a signup intent for a failed signup.", suggestedFix: "Check response.ok first." }).action).toBe("FIX")
    })

    it("a finding on Infinite's managed client file is Infinite's own code, decided by ownership before any design rule", () => {
      const runtimeClient = runtime.read("lib/infinite-analytics-client.tsx")
      expect(fileRoleOf("lib/infinite-analytics-client.tsx", runtimeClient)).toBe("client")
      const decided = triage(
        [finding({ item: "R3", path: "lib/infinite-analytics-client.tsx", line: 5, body: "The client posts page views to /infinite/collect, but the install rewrites only /infinite/ledger, so every page view 404s and never reaches Infinite's ledger.", suggestedFix: "Post to /infinite/ledger." })],
        ctx({
          ownership: (path) => (path === "lib/infinite-analytics-client.tsx" ? "Infinite's own code" : null),
          fileRole: (path) => (path === "lib/infinite-analytics-client.tsx" ? fileRoleOf(path, runtimeClient) : null),
          pageHelperCallsIn: (path) => (path === "lib/infinite-analytics-client.tsx" ? pageHelperCalls(runtimeClient, EXPORTS) : [])
        })
      )[0]!
      expect(decided).toMatchObject({ action: "INFINITE", label: "Infinite's own code" })
    })

    it("F4 sits on the page helper's call (infiniteTrackThenNavigate at line 19) in its own client file: asked with Infinite's rule", () => {
      expect(pageHelperCalls(HEAD_FILES["app/signup/page.tsx"]!, EXPORTS)).toEqual([{ helper: "infiniteTrackThenNavigate", literals: ["/account", "signup"], line: 19, endLine: 19 }])
      expect(decide(F4)).toMatchObject({ action: "ASK", askReason: "infinite_design", reason: infiniteDesignAsk(false) })
      // NEGATIVE: the same words on a client file that calls no page helper are not the design.
      const noCall = { ...files, "app/signup/page.tsx": HEAD_FILES["app/signup/page.tsx"]!.replace('infiniteTrackThenNavigate(event, "/account", "signup")', 'location.assign("/account")') }
      expect(triage([finding(F4)], ctx({ pageHelperCallsIn: callsIn(noCall), infiniteInternalsIn: internalsIn(noCall) }))[0]!.action).not.toBe("DECLINE")
    })
  })

  // LF4 close round 2 (P1-3): the verifier's repro (zz-cr1-triage), asserted. At 709c10b a finding was declined as
  // "Infinite's design" when its TEXT named the helper or one of its literals ("signup", even "/signup"), and the same
  // finding without the word was a FIX; each decline posted a false "Infinite counts a conversion from your server…"
  // and dropped a real customer bug. Now nothing is declined on its words: a finding on the helper's call is asked.
  describe("close round 2: never declined on a text match", () => {
    const decide = (input: Parameters<typeof finding>[0]) => triage([finding(input)], ctx())[0]!
    const A = { item: "R16", path: "app/signup/page.tsx", line: 19, body: "On the signup page, the submit handler navigates with a full reload before the page view beacon flushes, so the signup page's page view never reaches Infinite's ledger.", suggestedFix: "Use router.push for the navigation." }
    const B = { item: "R16", path: "app/signup/page.tsx", line: 7, body: "InfiniteAnalyticsClient is not rendered for this route segment, so the page view for /signup never reaches Infinite's collector.", suggestedFix: "Render the client in the root layout." }
    const C = { item: "R16", path: "app/signup/page.tsx", line: 19, body: "infiniteTrackThenNavigate runs only on response.ok but the form also posts on Enter twice, so GA4 counts two signup events per account; the signup never reaches Infinite's lane either.", suggestedFix: "Disable the button while submitting." }
    const D = { ...A, body: "On this page, the submit handler navigates with a full reload before the page view beacon flushes, so this page's page view never reaches Infinite's ledger." }

    it("A (a page view, 'signup page') and D (the same without 'signup') get the same decision: asked, never declined", () => {
      expect(decide(A).action).toBe("ASK")
      expect(decide(A).askReason).toBe("infinite_design")
      expect(decide(D).action).toBe(decide(A).action)
      expect(decide(D).askReason).toBe(decide(A).askReason)
    })

    it("B (\"/signup\" in the text, but not on the helper's call line) goes through the normal rules: a FIX", () => {
      expect(decide(B)).toMatchObject({ action: "FIX" })
    })

    it("C (a real GA4 double count that also says the signup never reaches Infinite) is asked with the server-lane words, never declined", () => {
      const decided = decide(C)
      expect(decided).toMatchObject({ action: "ASK", askReason: "infinite_design" })
      expect(decided.reason).toContain("you decide whether the agent fixes it")
      expect(decided.reason).not.toMatch(/^Not changed/)
    })

    it("NEGATIVE: no finding of the four is declined, and none without a line is placed on the call", () => {
      for (const input of [A, B, C, D]) expect(decide(input).action).not.toBe("DECLINE")
      expect(decide({ ...A, line: null as unknown as number }).askReason).not.toBe("infinite_design")
    })
  })
})
