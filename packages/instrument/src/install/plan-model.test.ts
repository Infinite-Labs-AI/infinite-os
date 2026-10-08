import { describe, expect, it } from "vitest"

import { candidate, fakeBefore, fakeHosting, fakeKeys, fakeProductionDeniedConflict, IDS, notConnectedKeys } from "../../test/wizard/o7-fakes.js"
import type { ImproveLine } from "../types.js"
import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import type { EventInventory } from "../scan/event-inventory.js"
import type { TestResult } from "../wizard/contracts/test-engine.js"

import {
  buildPlanModel,
  DECISION_LINE_IDS,
  duplicateFindings,
  EDITABLE_LINE_IDS,
  gateSeededItems,
  planAskPayload,
  resolvePlanAnswers,
  seedItemsAfterApprovals,
  type PlanModelInput,
  type PlanScanFacts,
  SERVER_LANE_HANDOFF_LINE_ID
} from "./plan-model.js"

type WizardBeforeFactsCensus = ReturnType<typeof fakeBefore>["census"]

function scanFacts(overrides: Partial<PlanScanFacts> = {}): PlanScanFacts {
  return {
    framework: "next-app-router",
    managedProviders: [],
    adopted: [],
    improve: [],
    serverLane: { targetLabel: "Next.js middleware", installPackages: [] },
    npm: null,
    sensitivePaths: [],
    ...overrides
  }
}

function input(overrides: Partial<PlanModelInput> = {}): PlanModelInput {
  return {
    scan: scanFacts(),
    keys: fakeKeys(),
    before: fakeBefore(),
    candidates: [],
    agent: { worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } },
    consentFlag: null,
    productionDeniedConflict: fakeProductionDeniedConflict,
    ...overrides
  }
}

it("founder ruling (P0-6): without Infinite's env writes the lane is still written, inert, its jobs seeded, and the plan says the owner adds the secret", () => {
  const item = candidate("server_conversions", "lead")
  const plan = buildPlanModel(input({
    before: fakeBefore({ hosting: fakeHosting({ envWriteGranted: false }) }),
    candidates: [item]
  }))
  const ids = plan.lines.map((line) => line.id)
  expect(ids).toContain("server_lane")
  expect(plan.lines.find((line) => line.id === SERVER_LANE_HANDOFF_LINE_ID)?.text).toBe("We'll write the server code; you add the secret in Vercel (steps in the PR).")
  // Never the "connect Vercel" dead end, and never a line asking to let Infinite write env vars it cannot write.
  expect(ids).not.toContain("user_action:server_lane")
  expect(ids).not.toContain("account_settings:hosting")
  expect(plan.withheld).not.toContain(item.id)
  expect(seedItemsAfterApprovals([item], [], plan, { approved: plan.lines.filter((line) => line.requires === "approval").map((line) => line.id), declined: [], edits: {} })).toContainEqual(expect.objectContaining({ id: item.id }))
})

it("withholds server outcome jobs when the framework has no server lane at all", () => {
  const item = candidate("server_conversions", "lead")
  const plan = buildPlanModel(input({ scan: scanFacts({ serverLane: null }), candidates: [item] }))
  expect(plan.withheld).toContain(item.id)
  expect(plan.lines.map((line) => line.id)).not.toContain(SERVER_LANE_HANDOFF_LINE_ID)
  expect(seedItemsAfterApprovals([item], [], plan, { approved: plan.lines.filter((line) => line.requires === "approval").map((line) => line.id), declined: [], edits: {} })).not.toContainEqual(expect.objectContaining({ id: item.id }))
})
const adoptedPosthogLines: ImproveLine[] = [
  { id: "improve_additive:posthog:proxy", kind: "improve_additive", provider: "posthog", target: "proxy", text: "PostHog: send events through /ingest.", owner: "code", evidence: { file: "index.html", line: 5 } },
  { id: "improve_additive:posthog:history_change", kind: "improve_additive", provider: "posthog", target: "history_change", text: "PostHog: history_change.", owner: "agent", evidence: { file: "index.html", line: 5 } },
  { id: "posthog_defaults_bump_adopted:posthog:defaults", kind: "posthog_defaults_bump_adopted", provider: "posthog", target: "defaults", text: "PostHog: defaults bump.", owner: "agent", evidence: { file: "index.html", line: 5 } }
]

describe("the plan model asks ONLY the three decisions", () => {
  it("conversion names and the npm line are the only editable lines; consent is never asked", () => {
    const plan = buildPlanModel(
      input({
        scan: scanFacts({ serverLane: { targetLabel: "Vercel root middleware", installPackages: ["@vercel/functions"] }, npm: { commandLine: "pnpm add @vercel/functions" } }),
        candidates: [candidate("server_conversions", "start_trial"), candidate("privacy_paragraph", "page")]
      })
    )
    const editable = plan.lines.filter((line) => line.editable).map((line) => line.id)
    expect(editable.sort()).toEqual([...EDITABLE_LINE_IDS].filter((id) => id !== DECISION_LINE_IDS.consentMode).sort())
    expect(plan.decisions).toEqual({
      consentMode: "not_required",
      conversionNames: ["start_trial"],
      privacyText: null,
      npmInstall: "pnpm add @vercel/functions"
    })
    expect(planAskPayload(plan).lines.every((line) => Object.keys(line).every((key) => ["id", "kind", "text", "requires", "editable", "measured", "jobIds", "ownership"].includes(key)))).toBe(true)
  })

  it("installs only connected tools, each with its connection's id in the line; missing ones are 'connect it' lines", () => {
    const plan = buildPlanModel(input({ keys: notConnectedKeys() }))
    const ids = plan.lines.map((line) => line.id)
    expect(ids).toContain("install_provider:infinite")
    expect(ids.filter((id) => id.startsWith("install_provider:"))).toEqual(["install_provider:infinite"])
    expect(ids).toEqual(expect.arrayContaining(["user_action:connect_ga4", "user_action:connect_posthog", "user_action:connect_meta"]))
    const full = buildPlanModel(input())
    expect(full.lines.map((line) => line.id)).toEqual(expect.arrayContaining([`install_provider:ga4:${IDS.ga4}`, `install_provider:posthog:${IDS.posthog}`, `install_provider:meta:${IDS.meta}`]))
  })
})

describe("adopted providers: repository work runs after the plan is shown and continued", () => {
  const posthogAdopted = scanFacts({ improve: adoptedPosthogLines, adopted: [{ provider: "posthog", via: "snippet", file: "index.html", line: 5, key: IDS.posthog }] })

  it("NEGATIVE: an adopted-provider job with no line at all is never seeded", () => {
    const plan = buildPlanModel(input())
    const stray = candidate("ga4_improve", "spa")
    // Build the plan WITHOUT the candidate, then gate an item no line links.
    const resolved = resolvePlanAnswers(plan, { approved: ["consent_mode"], declined: [], edits: { consent_mode: "required" } }, { consentFlag: null })
    expect(gateSeededItems(plan, resolved, [stray])).toEqual([])
  })
})

describe("duplicates and conflicts (GA4), from `before` only", () => {
  const gtm = { tool: "ga4" as const, kind: "gtm" as const, id: "GTM-ABC1234", file: "index.html", line: 3, owner: "adopted" as const }
  const gtag = (id: string) => ({ tool: "ga4" as const, kind: "gtag_config" as const, id, file: "index.html", line: 9, owner: "adopted" as const })
  const dry = (tids: string[]) =>
    ({ loads: [{ label: "home" }], ga4: { events: tids.map((tid) => ({ tid, en: "page_view", loadLabel: "home" })) }, meta: { tr: [] } }) as unknown as TestResult

  it("two different ids → a conflict line the user resolves (never a removal)", () => {
    const before = fakeBefore({ census: { entries: [gtm, gtag(IDS.ga4)], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }, dryLive: dry([IDS.ga4, IDS.ga4Other]) })
    const findings = duplicateFindings(before)
    expect(findings.map((finding) => finding.kind)).toEqual(["conflict"])
    const plan = buildPlanModel(input({ before }))
    expect(plan.lines.find((line) => line.id === "conflict:ga4")).toMatchObject({ kind: "user_action", requires: "user_action" })
  })

  it("NEGATIVE: GTM + gtag with ONE page view per visit is not a duplicate", () => {
    const before = fakeBefore({ census: { entries: [gtm, gtag(IDS.ga4)], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }, dryLive: dry([IDS.ga4]) })
    expect(duplicateFindings(before)).toEqual([])
  })
})

describe("the preview guard's exempt list (§3h.9, R2-21)", () => {
  it("emits the guard with exempt = site-source hosts ∪ hosting domains + aliases ∪ the observed host", () => {
    const plan = buildPlanModel(
      input({ before: fakeBefore({ hosting: fakeHosting({ productionDomains: ["acme-store.com", "www.acme-store.com"], productionAliases: ["acme-store.vercel.app"] }), observedProductionHost: "www.acme-store.com" }) })
    )
    expect(plan.guard).toMatchObject({ emit: true, exempt: ["acme-store.com", "www.acme-store.com", "acme-store.vercel.app"] })
    expect(plan.lines.find((line) => line.id === "preview_guard_managed")).toBeDefined()
  })

  it("NEGATIVE: no production host anywhere → no guard (an empty exempt list would silence production)", () => {
    const keys = fakeKeys({ infinite: { ...fakeKeys().infinite, productionHosts: [] } })
    const plan = buildPlanModel(input({ keys, before: fakeBefore({ hosting: { provider: "none", vercel: null }, observedProductionHost: null }) }))
    expect(plan.guard).toEqual({ emit: false, reason: "no_production_host" })
  })
})

describe("I1b: the guard spec is usable, and a pixel the census found is never installed twice", () => {
  it("an adopted Meta pixel only the census sees (inside a <Script> template literal) gets no install_provider line", () => {
    const census = { entries: [{ tool: "meta" as const, kind: "fbq_init" as const, id: IDS.meta, file: "app/layout.tsx", line: 27, owner: "adopted" as const }], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }
    const plan = buildPlanModel(input({ before: fakeBefore({ census }) }))
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:meta"))).toBe(false)
  })
})

describe("resolvePlanAnswers", () => {
  const plan = buildPlanModel(input({ candidates: [candidate("server_conversions", "start_trial")] }))

  it("needs no consent answer: the plan asks none and the tag installs active", () => {
    expect(plan.lines.some((line) => line.kind === "consent_mode")).toBe(false)
    expect(resolvePlanAnswers(plan, { approved: [], declined: [], edits: {} }, { consentFlag: null }).consentMode).toBe("not_required")
  })

  it("declined beats approved; unknown line ids are ignored", () => {
    const resolved = resolvePlanAnswers(plan, { approved: ["account_settings:hosting", "no_such_line"], declined: ["account_settings:hosting"], edits: {} }, { consentFlag: null })
    expect(resolved.lines.find((line) => line.id === "account_settings:hosting")?.approved).toBe(false)
    expect(resolved.approvals.approved).not.toContain("no_such_line")
  })
})

describe("review fixes (O7 fix round)", () => {
  const consent = { consent_mode: "not_required" }
  const census = (entries: Array<Record<string, unknown>>) =>
    ({ entries, envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }) as unknown as WizardBeforeFactsCensus

  it("P2-18: unless the agent-budget (cost) line is approved, every agent job waits for the user", () => {
    const candidates = [candidate("identify_reset", "auth")]
    const plan = buildPlanModel(input({ candidates, agent: { worker: "claude_code", whoPays: { payer: "api_key", label: "your API key pays" } } }))
    const declined = resolvePlanAnswers(plan, { approved: ["consent_mode"], declined: ["agent_budget"], edits: consent }, { consentFlag: null })
    expect(gateSeededItems(plan, declined, candidates)[0]).toMatchObject({ state: "blocked", blockedReason: "needs_you" })
    const approved = resolvePlanAnswers(plan, { approved: ["consent_mode", "agent_budget"], declined: [], edits: consent }, { consentFlag: null })
    expect(gateSeededItems(plan, approved, candidates)[0]?.state).toBe("pending")
  })

  it("P1-6: Infinite that cannot be installed (a static site off Vercel) is a user-action line, never an install line", () => {
    const plan = buildPlanModel(input({ scan: scanFacts({ framework: "static-html", infiniteBlocked: "your site is not served through Vercel" }) }))
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:infinite"))).toBe(false)
    expect(plan.lines.find((line) => line.id === "user_action:infinite_blocked")).toMatchObject({ requires: "user_action" })
    expect(plan.lines.some((line) => line.id.startsWith("install_provider:ga4"))).toBe(true)
  })
})

const inv = (events: EventInventory["events"], extra: Partial<EventInventory> = {}): EventInventory => ({ events, checkoutCreates: [], paymentWebhook: null, pixelRestrictedRoutes: [], siteCurrency: null, ...extra })
const site = (file: string, line: number, via: string) => ({ file, line, via })
/** A store shaped like the reference: GA4 + PostHog get every step, Meta gets page views only. */
const STORE_INVENTORY = inv([
  { event: "view_item", sites: [site("pages/products/[slug].tsx", 21, "helper:viewItem")], tools: { ga4: [site("src/analytics/events.ts", 23, "helper:sendGa")], posthog: [site("src/analytics/events.ts", 24, "helper:capturePosthog")] }, missing: ["meta_browser"] },
  { event: "add_to_cart", sites: [site("pages/index.tsx", 17, "helper:addToCart")], tools: { ga4: [site("src/analytics/events.ts", 28, "helper:sendGa")], posthog: [site("src/analytics/events.ts", 29, "helper:capturePosthog")] }, missing: ["meta_browser"] },
  { event: "begin_checkout", sites: [site("pages/api/checkout.ts", 67, "stripe.checkout.sessions.create")], tools: { ga4: [site("src/analytics/events.ts", 33, "helper:sendGa")], posthog: [site("src/analytics/events.ts", 34, "helper:capturePosthog")] }, missing: ["meta_server", "infinite"] },
  { event: "purchase", sites: [site("pages/success.tsx", 28, "helper:purchase")], tools: { ga4: [site("src/analytics/events.ts", 41, "helper:sendGa")], posthog: [site("src/analytics/events.ts", 45, "helper:capturePosthog")] }, missing: ["meta_server", "infinite"] },
  { event: "lead", sites: [site("pages/api/mailing-list.ts", 11, "form-api")], tools: { ga4: [site("src/analytics/events.ts", 52, "helper:sendGa")], posthog: [site("src/analytics/events.ts", 53, "helper:capturePosthog")] }, missing: ["meta_server", "infinite"] }
], { checkoutCreates: [site("pages/api/checkout.ts", 67, "stripe.checkout.sessions.create")] })
const withInventory = (item: ChecklistItem, events: readonly string[]): ChecklistItem => ({ ...item, inventory: STORE_INVENTORY.events.filter((entry) => events.includes(entry.event)) })
const ADOPTED_ALL: PlanScanFacts["adopted"] = [
  { provider: "meta", via: "snippet", file: "src/analytics/tracking.ts", line: 70, key: null },
  { provider: "ga4", via: "snippet", file: "src/analytics/tracking.ts", line: 50, key: null },
  { provider: "posthog", via: "snippet", file: "src/analytics/tracking.ts", line: 60, key: null }
]

describe("P1-8: the plan opens with one plain line per tool, built from the inventory", () => {
  it("never names an event the scan found no place for, and never claims what a withheld job cannot do", () => {
    const leadOnly = inv([STORE_INVENTORY.events.find((entry) => entry.event === "lead")!])
    // A framework with no server lane: the lead's server job is withheld.
    const plan = buildPlanModel(input({
      scan: scanFacts({ adopted: ADOPTED_ALL, eventInventory: leadOnly, serverLane: null }),
      candidates: [withInventory(candidate("server_conversions", "lead"), ["lead"])]
    }))
    const all = plan.lines.filter((line) => line.id.startsWith("headline:")).map((line) => line.text).join("\n")
    expect(all).not.toMatch(/ViewContent|AddToCart|Purchase|InitiateCheckout|purchases|checkout/)
    expect(plan.lines.find((line) => line.id === "headline:meta")?.text).toBe("Meta: gets page views only today.")
    expect(plan.lines.find((line) => line.id === "headline:meta_server_lane")?.text).toContain("Lead can't be sent from your server yet.")
    expect(plan.lines.find((line) => line.id === "headline:infinite")?.text).toContain("Leads can't be recorded from your server yet.")
  })
})

