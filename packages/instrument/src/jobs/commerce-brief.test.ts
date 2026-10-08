// Review P0-5 (instruction side): the browser-event job briefs, built from the scan's event × tool inventory. Each
// names the exact file and line where the event already fires, which tools it already reaches there, and the ONE tool
// (or the missing tools) the agent adds through `destinations`; purchases, checkout starts and leads reach Meta and
// Infinite from the server and are never sent from the browser. Store shapes below are invented.
import { describe, expect, it } from "vitest"

import type { ChecklistItem } from "../wizard/contracts/jobs.js"
import { buildBrief, commerceJobTitle, HELPER_API, type BriefFacts, type EventInventoryEntry } from "./briefs.js"

const ADD_TO_CART: EventInventoryEntry = {
  event: "add_to_cart",
  sites: [
    { file: "pages/index.tsx", line: 42, via: "helper:addToCartEvent" },
    { file: "pages/trail-pack.tsx", line: 88, via: "helper:addToCartEvent" }
  ],
  tools: {
    ga4: [{ file: "lib/store-events.ts", line: 152, via: "gtag" }],
    posthog: [{ file: "lib/store-events.ts", line: 157, via: "posthog.capture" }]
  },
  missing: ["meta_browser"]
}
const VIEW_ITEM: EventInventoryEntry = {
  event: "view_item",
  sites: [{ file: "pages/trail-pack.tsx", line: 30, via: "helper:viewItem" }],
  tools: { ga4: [{ file: "lib/store-events.ts", line: 146, via: "gtag" }] },
  missing: ["meta_browser", "posthog"]
}
const PURCHASE: EventInventoryEntry = {
  event: "purchase",
  sites: [{ file: "pages/success.tsx", line: 12, via: "success-page" }],
  tools: { ga4: [{ file: "lib/store-events.ts", line: 214, via: "gtag" }], posthog: [{ file: "lib/store-events.ts", line: 220, via: "posthog.capture" }] },
  missing: ["meta_server", "infinite"]
}
const LEAD: EventInventoryEntry = {
  event: "lead",
  sites: [{ file: "components/NewsletterForm.tsx", line: 31, via: "helper:generateLead" }],
  tools: { ga4: [{ file: "lib/store-events.ts", line: 224, via: "gtag" }] },
  missing: ["posthog", "meta_server", "infinite"]
}

function item(id: string, inventory: EventInventoryEntry[], files: string[]): ChecklistItem {
  return {
    id,
    jobId: id.split(":")[0] as ChecklistItem["jobId"],
    n: id.startsWith("meta") ? 5 : id.startsWith("ga4") ? 4 : id.startsWith("posthog") ? 3 : 10,
    title: "lane A's title",
    owner: "agent",
    trigger: { finding: "found by the scan", evidence: inventory.flatMap((entry) => entry.sites.map((site) => ({ file: site.file, line: site.line }))) },
    allow: { files, create: [] },
    checks: [],
    state: "pending",
    inventory
  } as ChecklistItem
}

const facts: BriefFacts = {
  runId: "85483904-c9a1-4125-bb85-8fd66e709247",
  framework: "next-pages-router",
  packageManager: "npm",
  router: "pages",
  appRoot: ".",
  plan: { conversionNames: ["lead", "purchase"], privacyText: null, lines: [] },
  connections: { ga4MeasurementIds: [], posthog: null, metaPixelIds: ["1116400780828774"] },
  helpers: { module: "lib/infinite-analytics.ts" },
  consentMode: "not_required"
}

const planData = (brief: string, id: string): Record<string, unknown> => {
  const block = brief.slice(brief.indexOf(`### Job "${id}"`))
  return JSON.parse(/Plan data \(JSON; decided by the user, use it exactly\): (.*)$/m.exec(block)![1]!) as Record<string, unknown>
}

describe("browser commerce briefs (review P0-5)", () => {
  it("the Buy button that already sends GA4 add_to_cart: add Meta AddToCart ONLY, at the named file and line, and wait before leaving", () => {
    const brief = buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART, VIEW_ITEM], ["lib/store-events.ts", "pages/index.tsx", "pages/trail-pack.tsx"])], facts)
    expect(brief).toContain('### Job "meta_improve:commerce_events" (5. Adding Meta AddToCart and ViewContent with product and price)')
    const data = planData(brief, "meta_improve:commerce_events")
    expect(data.destinations).toEqual(["meta"])
    expect(data.events).toEqual([
      {
        event: "add_to_cart",
        metaEventName: "AddToCart",
        firesAt: ["pages/index.tsx:42 (helper:addToCartEvent)", "pages/trail-pack.tsx:88 (helper:addToCartEvent)"],
        alreadySentTo: { GA4: ["lib/store-events.ts:152 (gtag)"], PostHog: ["lib/store-events.ts:157 (posthog.capture)"] },
        add: ["Meta"]
      },
      {
        event: "view_item",
        metaEventName: "ViewContent",
        firesAt: ["pages/trail-pack.tsx:30 (helper:viewItem)"],
        alreadySentTo: { GA4: ["lib/store-events.ts:146 (gtag)"] },
        add: ["Meta"]
      }
    ])
    expect(data.helperImport).toBe('import { infiniteTrack, infiniteTrackThenNavigate } from "./infinite-analytics"')
    expect(brief).toContain('{ destinations: ["meta"] }')
    expect(brief).toContain("infiniteTrackThenNavigate(event, <where the click goes>")
    expect(brief).toContain("at most 400 ms")
    expect(brief).toContain("Never invent a price")
    expect(brief).toContain("currency the site prices in")
    expect(brief).toContain("Never add a tool already listed in alreadySentTo")
    // The wizard's rehearsal and prove click `[data-infinite-conversion="add_to_cart"]`.
    expect(brief).toContain('add the attribute data-infinite-conversion="add_to_cart" to the button element itself')
  })

  it("a GA4 job names GA4 only, and a PostHog job PostHog only", () => {
    const brief = buildBrief(
      [
        item("ga4_improve:commerce_events", [{ ...ADD_TO_CART, missing: ["ga4"], tools: { posthog: ADD_TO_CART.tools.posthog } }], ["lib/store-events.ts"]),
        item("posthog_improve:commerce_events", [VIEW_ITEM], ["lib/store-events.ts"])
      ],
      facts
    )
    expect(planData(brief, "ga4_improve:commerce_events").destinations).toEqual(["ga4"])
    expect(planData(brief, "posthog_improve:commerce_events").destinations).toEqual(["posthog"])
    expect(brief).toContain("(4. Adding GA4 add_to_cart with product and price)")
    expect(brief).toContain("(3. Adding PostHog view_item with product and price)")
    // Two jobs at one place: one call with both tools.
    expect(brief).toContain("make it ONE call with both tools in destinations")
  })

  it("never instructs a browser Meta purchase: a server-only event in a Meta commerce item is dropped", () => {
    const brief = buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART, { ...PURCHASE, missing: ["meta_browser"] }], ["lib/store-events.ts"])], facts)
    const events = planData(brief, "meta_improve:commerce_events").events as Array<{ event: string }>
    expect(events.map((entry) => entry.event)).toEqual(["add_to_cart"])
    expect(brief).not.toContain('"metaEventName":"Purchase"')
  })

  it("refuses to brief a commerce job with nothing to add (never a guess)", () => {
    expect(() => buildBrief([item("meta_improve:commerce_events", [{ ...ADD_TO_CART, missing: [] }], ["lib/store-events.ts"])], facts)).toThrow(/misses/)
    expect(() => buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART], ["lib/store-events.ts"])], { ...facts, helpers: null })).toThrow(/helpers/)
  })
})

describe("conversion briefs from the inventory (review P0-5)", () => {
  it("a lead the site already sends to GA4: add PostHog only, and pass the ad-match signal to the site's own API route", () => {
    const brief = buildBrief([item("conversions_to_tools:lead", [LEAD], ["components/NewsletterForm.tsx"])], facts)
    const data = planData(brief, "conversions_to_tools:lead")
    expect(data.destinations).toEqual(["posthog"])
    expect(data.helperImport).toBe('import { infiniteTrack, infiniteTrackThenNavigate, infiniteAdMatchAllowed } from "../lib/infinite-analytics"')
    expect(brief).toContain('{ destinations: ["posthog"] }')
    expect(brief).toContain("adMatch: infiniteAdMatchAllowed()")
    expect(brief).toContain("Meta and Infinite get it from your server")
    expect(brief).not.toContain('call infiniteTrack("lead")')
  })

  it("never tells the agent to send a purchase from the browser", () => {
    const brief = buildBrief([item("conversions_to_tools:purchase", [PURCHASE], ["pages/success.tsx"])], facts)
    expect(brief).toContain("add NOTHING in the browser")
    expect(brief).toContain("reported from your server")
    expect(brief).not.toMatch(/infiniteTrack\(\s*"purchase"/)
    // The legacy item with no inventory is the same.
    const legacy = buildBrief([item("conversions_to_tools:purchase", [], ["pages/success.tsx"])], facts)
    expect(legacy).toContain("add NOTHING in the browser")
    expect(legacy).not.toMatch(/infiniteTrack\(\s*"purchase"/)
  })

  it("a conversion every browser tool already gets is refused, not briefed", () => {
    expect(() => buildBrief([item("conversions_to_tools:lead", [{ ...LEAD, missing: ["meta_server", "infinite"] }], ["components/NewsletterForm.tsx"])], facts)).toThrow(/no browser tool/)
  })
})

describe("titles and the helper API say what we are doing", () => {
  it("titles name the tool and the events", () => {
    expect(commerceJobTitle("meta_browser", ["view_item", "add_to_cart"])).toBe("Adding Meta AddToCart and ViewContent with product and price")
    expect(commerceJobTitle("ga4", ["begin_checkout"])).toBe("Adding GA4 begin_checkout with product and price")
  })

  it("the helper API documents destinations, the ad-match signal and that conversions are the server's", () => {
    expect(HELPER_API).toContain('`[\\"meta\\"]` = Meta only'.replace(/\\"/g, '"'))
    expect(HELPER_API).toContain("infiniteAdMatchAllowed()")
    expect(HELPER_API).toContain("Purchase, checkout starts and leads go to Meta and Infinite from the server")
    expect(HELPER_API).toContain("It never builds a Meta eventID")
  })
})
