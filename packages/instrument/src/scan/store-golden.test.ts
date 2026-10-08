// Golden: a store shaped like the first store customer (invented: test/scan/fixtures/store-*), from its code to the
// plan's first lines. Before this, the wizard proposed only `lead` and a browser `purchase` that double-counted GA4 and
// sent Meta nothing (review P0-4, P0-5, P1-8). Now: the scan sees the whole funnel, the jobs fill only the gaps (Meta
// ViewContent / AddToCart in the browser; checkout start, purchase from a NEW webhook, and lead from the server), and the
// plan opens with one plain line per tool.
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { fakeBefore, fakeKeys, fakeProductionDeniedConflict } from "../../test/wizard/o7-fakes.js"
import { runCensus } from "../checks/census.js"
import { buildPlanModel, resolvePlanAnswers, seedItemsAfterApprovals, type PlanModelInput } from "../install/plan-model.js"
import { jobScanFrom, type JobScan } from "../jobs/detectors/index.js"
import { applyApprovalsTo, seedCandidatesFrom } from "../jobs/registry.js"
import { loadRepoSnapshot } from "../jobs/repo-files.js"
import type { TagKeys } from "../wizard/contracts/bridge.js"
import { CHECKLIST_ITEM_SHAPE, type ChecklistItem } from "../wizard/contracts/jobs.js"
import { shapeErrors } from "../wizard/contracts/shape.js"

const fixture = (name: string) => fileURLToPath(new URL(`../../test/scan/fixtures/${name}`, import.meta.url))

function storeRun(name: string, keys: TagKeys = fakeKeys()) {
  const root = fixture(name)
  const scan: JobScan = jobScanFrom({ root, appRoot: ".", framework: "next-pages-router", packageManager: "npm", fileCount: 20, truncated: false }, loadRepoSnapshot(root, "."))
  const census = runCensus({ root, appRoot: "." })
  const before = fakeBefore({ census, keys })
  const candidates = seedCandidatesFrom(scan, before)
  const adopted = census.entries
    .filter((entry) => entry.owner === "adopted" && entry.tool !== "infinite" && entry.tool !== "x")
    .map((entry) => ({ provider: entry.tool as "ga4" | "posthog" | "meta", via: "snippet" as const, file: entry.file, line: entry.line, key: entry.id }))
  const input: PlanModelInput = {
    scan: {
      framework: "next-pages-router",
      managedProviders: [],
      adopted,
      improve: [],
      serverLane: { targetLabel: "Next.js middleware", installPackages: [] },
      npm: null,
      sensitivePaths: [],
      eventInventory: scan.detections.eventInventory
    },
    keys,
    before,
    candidates,
    agent: { worker: "claude_code", whoPays: { payer: "plan", label: "your Claude plan pays" } },
    consentFlag: null,
    productionDeniedConflict: fakeProductionDeniedConflict
  }
  const plan = buildPlanModel(input)
  return { scan, candidates, plan }
}

const open = (items: readonly ChecklistItem[]) => items.filter((item) => item.state !== "left_for_you")

describe("store-halden: scan → inventory → jobs → plan", () => {
  const { scan, candidates, plan } = storeRun("store-halden")

  it("seeds one job per gap, and none for an event a tool already gets (GA4 and PostHog get every step)", () => {
    expect(open(candidates).map((item) => [item.id, item.title, item.state])).toEqual([
      ["meta_improve:commerce_events", "Add Meta ViewContent and AddToCart in the browser", "pending"],
      ["server_conversions:begin_checkout", "Report checkout starts from the server", "pending"],
      ["server_conversions:lead", "Report the lead conversion from the server", "pending"],
      ["server_conversions:purchase", "Report purchases from a new payment webhook", "pending"]
    ])
    // P0-5: no browser purchase / lead job: GA4 `purchase` and PostHog `purchase_completed` already fire on /success.
    expect(candidates.some((item) => item.jobId === "conversions_to_tools")).toBe(false)
  })

  it("attaches the inventory entry to each job, with the exact files, lines and missing tools the briefs name", () => {
    const byId = new Map(candidates.map((item) => [item.id, item]))
    const meta = byId.get("meta_improve:commerce_events")!
    expect(meta.inventory?.map((entry) => [entry.event, entry.missing])).toEqual([
      ["view_item", ["meta_browser"]],
      ["add_to_cart", ["meta_browser"]]
    ])
    // The trigger sites, then the site's own send helper lines (where GA4 and PostHog already get each event).
    expect(meta.trigger.evidence).toEqual([
      { file: "pages/products/[slug].tsx", line: 21 },
      { file: "pages/index.tsx", line: 17 },
      { file: "pages/products/[slug].tsx", line: 29 },
      { file: "src/analytics/events.ts", line: 23 },
      { file: "src/analytics/events.ts", line: 24 },
      { file: "src/analytics/events.ts", line: 28 },
      { file: "src/analytics/events.ts", line: 29 }
    ])
    // The trigger sites and the site's own send helper; never the consent module.
    expect(meta.allow).toEqual({ files: ["pages/index.tsx", "pages/products/[slug].tsx", "src/analytics/events.ts"], create: [] })
    expect(meta.trigger.finding).toBe(
      "Meta: add ViewContent and AddToCart where your site already tracks product views (pages/products/[slug].tsx:21) and add-to-cart (pages/index.tsx:17, pages/products/[slug].tsx:29)."
    )

    const purchase = byId.get("server_conversions:purchase")!
    expect(purchase.allow).toEqual({ files: ["pages/api/checkout.ts"], create: ["pages/api/stripe-webhook.ts"] })
    expect(purchase.inventory?.[0]).toMatchObject({ event: "purchase", missing: ["meta_server", "infinite"] })
    expect(purchase.trigger.evidence).toEqual([{ file: "pages/api/checkout.ts", line: 67 }])

    const checkout = byId.get("server_conversions:begin_checkout")!
    expect(checkout.allow).toEqual({ files: ["pages/api/checkout.ts"], create: [] })
    expect(checkout.inventory?.[0]?.sites).toContainEqual({ file: "pages/api/checkout.ts", line: 67, via: "stripe.checkout.sessions.create" })

    const lead = byId.get("server_conversions:lead")!
    expect(lead.allow).toEqual({ files: ["pages/api/mailing-list.ts"], create: [] })
    expect(lead.inventory?.[0]?.sites).toContainEqual({ file: "pages/api/mailing-list.ts", line: 11, via: "form-api" })

    // The stored item shape accepts the inventory (the run state round-trips it).
    for (const item of candidates) expect(shapeErrors(JSON.parse(JSON.stringify(item)), CHECKLIST_ITEM_SHAPE, "item")).toEqual([])
  })

  it("the plan opens with the per-tool headline, in plain words, and proposes relay-mapped conversion names", () => {
    expect(plan.lines.slice(0, 4).map((line) => [line.id, line.text])).toEqual([
      [
        "headline:meta",
        "Meta: gets page views only today. We'll add ViewContent and AddToCart in the browser, where your site already tracks product views and add-to-cart, and send InitiateCheckout, Purchase and Lead from your server."
      ],
      ["headline:ga4", "GA4: gets product views, add-to-cart, checkout starts, purchases and leads today. Nothing to add."],
      ["headline:posthog", "PostHog: gets product views, add-to-cart, checkout starts, purchases and leads today. Nothing to add."],
      ["headline:infinite", "Infinite: records page views once its tag is live. We'll record checkout starts, purchases and leads from your server."]
    ])
    expect(plan.decisions.conversionNames).toEqual(["begin_checkout", "lead", "purchase"])
    for (const line of plan.lines) expect(line.text).not.toMatch(/eventID|metaEventId|top-level path|mirror|dedupe|count every event/i)
  })

  it("approving the plan seeds exactly those jobs (the approved names bind every server job)", () => {
    const approved = plan.lines.filter((line) => line.requires === "approval").map((line) => line.id)
    const answers = resolvePlanAnswers(plan, { approved, declined: [], edits: {} }, { consentFlag: null })
    const seeded = open(seedItemsAfterApprovals(candidates, plan.seeds, plan, answers.approvals))
    expect(seeded.map((item) => [item.id, item.state])).toEqual([
      ["meta_improve:commerce_events", "pending"],
      ["server_conversions:begin_checkout", "pending"],
      ["server_conversions:lead", "pending"],
      ["server_conversions:purchase", "pending"]
    ])
    expect(applyApprovalsTo(candidates, plan, answers.approvals).find((item) => item.id === "server_conversions:purchase")?.inventory?.[0]?.event).toBe("purchase")
    expect(scan.detections.eventInventory.pixelRestrictedRoutes).toEqual(["/cart", "/mailing-list", "/success"])
  })

  it("Meta not connected in Infinite: the browser events still run; the server events are one plain 'once connected' line", () => {
    const { plan: unconnected } = storeRun("store-halden", fakeKeys({ meta: { status: "not_connected", pixels: [] } }))
    expect(unconnected.lines.slice(0, 2).map((line) => line.text)).toEqual([
      "Meta: gets page views only today. We'll add ViewContent and AddToCart in the browser, where your site already tracks product views and add-to-cart.",
      "Meta gets InitiateCheckout, Purchase and Lead from your server once Meta is connected in Infinite (Connections › Meta)."
    ])
  })
})

describe("store-chain: the two-level sender chain", () => {
  const { candidates, plan } = storeRun("store-chain")

  it("fills PostHog's missing product view and Meta's browser steps; the server jobs as for any store", () => {
    expect(open(candidates).map((item) => item.id)).toEqual([
      "posthog_improve:commerce_events",
      "meta_improve:commerce_events",
      "server_conversions:begin_checkout",
      "server_conversions:lead",
      "server_conversions:purchase"
    ])
    const posthog = candidates.find((item) => item.id === "posthog_improve:commerce_events")!
    expect(posthog.title).toBe("Add PostHog product views in the browser")
    expect(posthog.inventory?.map((entry) => entry.event)).toEqual(["view_item"])
    // The product view fires from a consent component: never an edit place; the `viewItem()` helper it calls is.
    expect(posthog.allow).toEqual({ files: ["src/common/analytics.ts"], create: [] })
    expect(candidates.find((item) => item.id === "meta_improve:commerce_events")!.allow.files).not.toContain("components/ConsentNotice.tsx")
    expect(candidates.find((item) => item.id === "server_conversions:lead")!.allow.files).toEqual(["pages/api/mailing-list.ts"])
  })

  it("says per tool what it gets and what is added", () => {
    const text = (id: string) => plan.lines.find((line) => line.id === id)?.text
    expect(text("headline:posthog")).toBe("PostHog: gets add-to-cart, checkout starts, purchases and leads today. We'll add product views.")
    expect(text("headline:ga4")).toBe("GA4: gets product views, add-to-cart, checkout starts, purchases and leads today. Nothing to add.")
  })
})
