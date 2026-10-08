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
  it("the Buy button that already sends GA4 add_to_cart: add Meta AddToCart ONLY, inside the site's helper, once", () => {
    const brief = buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART, VIEW_ITEM], ["lib/store-events.ts", "pages/index.tsx", "pages/trail-pack.tsx"])], facts)
    expect(brief).toContain('### Job "meta_improve:commerce_events" (5. Adding Meta AddToCart and ViewContent with product and price)')
    const data = planData(brief, "meta_improve:commerce_events")
    // Meta, and Infinite's ledger (every commerce event reaches Infinite too); never GA4 or PostHog, which have it.
    expect(data.destinations).toEqual(["meta", "infinite"])
    const events = data.events as Array<Record<string, unknown>>
    expect(events.map((entry) => [entry.event, entry.metaEventName, entry.alreadySentTo, entry.add])).toEqual([
      ["add_to_cart", "AddToCart", { GA4: ["lib/store-events.ts:152 (gtag)"], PostHog: ["lib/store-events.ts:157 (posthog.capture)"] }, ["Meta"]],
      ["view_item", "ViewContent", { GA4: ["lib/store-events.ts:146 (gtag)"] }, ["Meta"]]
    ])
    // ONE place per event: inside the site's own helper (where it sends today when the scan names no definition).
    const places = events[0]!.places as Array<Record<string, unknown>>
    expect(places).toHaveLength(1)
    expect(places[0]!.firesThrough).toBe("your helper addToCartEvent() at lib/store-events.ts:152")
    // The scan could not tell how these clicks leave: the brief says how to tell, and never asks for two sends.
    expect((places[0]!.callers as Array<Record<string, unknown>>).map((caller) => [caller.at, caller.leaves])).toEqual([
      ["pages/index.tsx:42", "unknown: tell it apart yourself"],
      ["pages/trail-pack.tsx:88", "unknown: tell it apart yourself"]
    ])
    expect(brief).toContain("never also in a click handler that calls the helper (that sends the event twice)")
    expect(brief).toContain("A full page load is `window.location…`")
    expect(data.imports).toEqual({ "lib/store-events.ts": 'import { infiniteTrack } from "./infinite-analytics"' })
    expect(brief).toContain('{ destinations: ["meta", "infinite"] }')
    expect(brief).toContain("at most 400 ms")
    expect(brief).toContain("Never invent a price")
    expect(brief).toContain("currency the site prices in")
    expect(brief).toContain("Never add a tool already listed in alreadySentTo")
    // The wizard's rehearsal and prove click `[data-infinite-conversion="add_to_cart"]`.
    expect(brief).toContain('add the attribute data-infinite-conversion="add_to_cart" to the button element itself')
  })

  it("P1-A: a helper whose caller does a FULL page load returns the wait, and only that caller is wrapped; client routing is left alone", () => {
    const helperAt = { file: "src/analytics/events.ts", line: 27 }
    const entry: EventInventoryEntry = {
      ...ADD_TO_CART,
      sites: [
        { file: "pages/index.tsx", line: 17, via: "helper:addToCart", navigation: "full_load", navigationVia: "window.location.assign", helperAt },
        { file: "pages/products/[slug].tsx", line: 29, via: "helper:addToCart", navigation: "client", navigationVia: 'router.push("/cart")', helperAt }
      ],
      tools: { ga4: [{ file: "src/analytics/events.ts", line: 28, via: "gtag" }] }
    }
    const brief = buildBrief([item("meta_improve:commerce_events", [entry], ["pages/index.tsx", "pages/products/[slug].tsx", "src/analytics/events.ts"])], facts)
    const data = planData(brief, "meta_improve:commerce_events")
    const place = ((data.events as Array<Record<string, unknown>>)[0]!.places as Array<Record<string, unknown>>)[0]!
    expect(place.firesThrough).toBe("your helper addToCart() at src/analytics/events.ts:27")
    expect(place.inTheHelper).toMatch(/^return infiniteTrackBeforeLeaving\("add_to_cart", \{ item_id: .*\}, \{ destinations: \["meta", "infinite"\] \}\) beside its existing sends/)
    expect(place.callers).toEqual([
      { at: "pages/index.tsx:17", leaves: "with a full page load: window.location.assign", do: "wrap this click handler: infiniteLeaveAfter(() => { <everything the handler did before it left>; return addToCart(…) }, () => <the handler's own navigation, exactly as written>)" },
      { at: "pages/products/[slug].tsx:29", leaves: 'by client-side routing: router.push("/cart")', do: "leave this handler as it is" }
    ])
    // P2-1: each import is relative to the file it goes in.
    expect(data.imports).toEqual({
      "pages/index.tsx": 'import { infiniteLeaveAfter } from "../lib/infinite-analytics"',
      "src/analytics/events.ts": 'import { infiniteTrackBeforeLeaving } from "../../lib/infinite-analytics"'
    })
    expect(brief).toContain("Never turn client routing into a full page load.")
  })

  it("P1-A: an event sent inline in a click handler gets infiniteTrack there, and infiniteTrackThenNavigate ONLY when that handler does a full page load", () => {
    const entry: EventInventoryEntry = {
      event: "add_to_cart",
      sites: [
        { file: "components/BuyButton.tsx", line: 9, via: "gtag", navigation: "full_load", navigationVia: "location.href =" },
        { file: "components/QuickAdd.tsx", line: 14, via: "gtag", navigation: "none", navigationVia: "no navigation" }
      ],
      tools: { ga4: [{ file: "components/BuyButton.tsx", line: 9, via: "gtag" }, { file: "components/QuickAdd.tsx", line: 14, via: "gtag" }] },
      missing: ["meta_browser"]
    }
    const brief = buildBrief([item("meta_improve:commerce_events", [entry], ["components/BuyButton.tsx", "components/QuickAdd.tsx"])], facts)
    const data = planData(brief, "meta_improve:commerce_events")
    const places = (data.events as Array<Record<string, unknown>>)[0]!.places as Array<Record<string, unknown>>
    expect(places.map((place) => [place.firesThrough, place.leaves])).toEqual([
      ["inline at components/BuyButton.tsx:9 (gtag), not through a helper", "with a full page load: location.href ="],
      ["inline at components/QuickAdd.tsx:14 (gtag), not through a helper", "it does not leave the page"]
    ])
    expect(places[0]!.do).toMatch(/^replace the handler's own navigation with infiniteTrackThenNavigate\(event, <where the click goes>, "add_to_cart", \{/)
    expect(places[1]!.do).toMatch(/^infiniteTrack\("add_to_cart", \{.*\) beside the site's own send$/)
    expect(data.imports).toEqual({
      "components/BuyButton.tsx": 'import { infiniteTrackThenNavigate } from "../lib/infinite-analytics"',
      "components/QuickAdd.tsx": 'import { infiniteTrack } from "../lib/infinite-analytics"'
    })
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
