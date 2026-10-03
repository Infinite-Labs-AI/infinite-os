// R4-5 (live run 4): Codex's five findings on PR #5, triaged as the wizard now does. Run 4 handed F3, F4 and F5 to
// Claude Code as FIX; it spent its whole round looking for code it may not change ("Not fixed: the agent ran out of its
// 5 minutes"). Each is now decided before any agent sees it, with the real reason; a real customer-code finding is
// still a FIX. The finding texts are Codex's, verbatim (`pr5-review-inline-comments.md`).
import { describe, expect, it } from "vitest"

import { infinitePageConversionReply, triage, type TriageContext, type TriageItem } from "./triage.js"

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
  source: "reviewer",
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
  ...over
})

describe("R4-5: live run 4's findings never reach an agent that cannot fix them", () => {
  it("F3 (R9, 'Meta lacks SPA page views') is declined by the rehearsal's own Meta page-change check", () => {
    const [decision] = triage([finding(F3)], ctx())
    expect(decision).toMatchObject({ action: "DECLINE" })
    expect(decision!.reason).toContain("meta_spa_page_view")
  })

  it("F4 ('the signup never reaches Infinite's collector') is declined with the real reason, naming the missing server lane", () => {
    const [decision] = triage([finding(F4)], ctx())
    expect(decision).toEqual({ item: expect.anything(), action: "DECLINE", reason: infinitePageConversionReply(false) })
    expect(decision!.reason).toContain("never from the page")
    expect(decision!.reason).toContain("connect your Vercel project in Infinite")
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
})
