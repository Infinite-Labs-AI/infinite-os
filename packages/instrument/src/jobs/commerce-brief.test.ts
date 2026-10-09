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
  connections: { ga4MeasurementIds: [], posthog: null, metaPixelIds: ["1234567890123456"] },
  helpers: { module: "lib/infinite-analytics.ts" },
  consentMode: "not_required"
}

const planData = (brief: string, id: string): Record<string, unknown> => {
  const block = brief.slice(brief.indexOf(`### Job "${id}"`))
  return JSON.parse(/Plan data \(JSON; decided by the user, use it exactly\): (.*)$/m.exec(block)![1]!) as Record<string, unknown>
}
/** One job's block (the commerce job says its places in sentences, not as Plan data JSON). */
const jobText = (brief: string, id: string): string => {
  const start = brief.indexOf(`### Job "${id}"`)
  const next = brief.indexOf("\n### Job ", start + 1)
  return brief.slice(start, next === -1 ? undefined : next)
}
const META_CALL = (name: string) => `${name}("add_to_cart", <product>, { destinations: ["meta", "infinite"] })`

describe("browser commerce briefs (review P0-5)", () => {
  it("the Buy button that already sends GA4 add_to_cart: add Meta AddToCart ONLY, inside the site's helper, once", () => {
    const brief = buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART, VIEW_ITEM], ["lib/store-events.ts", "pages/index.tsx", "pages/trail-pack.tsx"])], facts)
    expect(brief).toContain('### Job "meta_improve:commerce_events" (5. Adding Meta AddToCart and ViewContent with product and price)')
    const job = jobText(brief, "meta_improve:commerce_events")
    // Plain sentences, never the old JSON keys the agent had to decode.
    expect(job).not.toMatch(/firesThrough|inTheHelper|callers\[\]|alreadySentTo|Plan data/)
    // Meta, and Infinite's ledger (every commerce event reaches Infinite too); never GA4 or PostHog, which have it.
    expect(job).toContain("- `add_to_cart` (Meta AddToCart). GA4 and PostHog already get it.")
    expect(job).toContain("- `view_item` (Meta ViewContent). GA4 already gets it.")
    expect(job).toContain("Never add a tool that already gets the event")
    // ONE place per event: inside the site's own helper (where it sends today when the scan names no definition).
    expect(job).toContain(`It fires through your helper \`addToCartEvent()\` at lib/store-events.ts:152. In the helper, beside its existing sends: \`${META_CALL("infiniteTrack")}\``)
    expect(job.match(/It fires through your helper `addToCartEvent\(\)`/g)).toHaveLength(1)
    // The scan could not tell how these clicks leave: the brief says how to tell, and never asks for two sends.
    expect(job).toContain("Its callers: pages/index.tsx:42, pages/trail-pack.tsx:88, each leaves in a way the scan could not tell: tell how it leaves yourself (see below) and write that row's shape.")
    expect(job).toContain("never also in a click handler that calls the helper (that sends the event twice)")
    expect(job).toContain("Where the scan could not tell how a click leaves, tell it apart yourself: A full page load is `window.location…`")
    // Unknown: every row of the table applies.
    expect(job.match(/^\| (?!How the click|---)/gm)).toHaveLength(6)
    expect(job).toContain('Import lines, as written: lib/store-events.ts: `import { infiniteTrack } from "./infinite-analytics"`.')
    expect(job).toContain('{ destinations: ["meta", "infinite"] }')
    expect(brief).toContain("at most 400 ms")
    expect(job).toContain("Never invent a price")
    expect(job).toContain("currency the site prices in")
    // The wizard's rehearsal and prove click `[data-infinite-conversion="add_to_cart"]`.
    expect(job).toContain('Add the attribute data-infinite-conversion="add_to_cart" to the button element itself')
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
    const job = jobText(brief, "meta_improve:commerce_events")
    expect(job).toContain("It fires through your helper `addToCart()` at src/analytics/events.ts:27.")
    // Finding 3: the reference fix's shape: the wait first, the helper's own sends unchanged, `return wait` last.
    expect(job).toContain(`In the helper, as its FIRST new line: \`const wait = ${META_CALL("infiniteTrackBeforeLeaving")}\`; then every send the helper already has, exactly as it is; then as its LAST line: \`return wait\``)
    expect(job).not.toContain("return infiniteTrackBeforeLeaving")
    expect(job).toContain("Its callers: pages/index.tsx:17 leaves with a full page load (window.location.assign): wrap this click handler: `infiniteLeaveAfter(() => { <everything the handler did before it left>; return addToCart(…) }, () => <the handler's own navigation, exactly as written>)`. pages/products/[slug].tsx:29 routes on the client (router.push(\"/cart\")): leave it as it is.")
    // P2-1: each import is relative to the file it goes in.
    expect(job).toContain('Import lines, as written: pages/index.tsx: `import { infiniteLeaveAfter } from "../lib/infinite-analytics"`; src/analytics/events.ts: `import { infiniteTrackBeforeLeaving } from "../../lib/infinite-analytics"`.')
    // The table shows only the two rows these callers need.
    expect(job).toContain("| Through your helper; the click then does a full page load |")
    expect(job).toContain("never turn client routing into a full page load.")
    expect(job).not.toContain("| A plain link")
    expect(job).not.toContain("tell it apart yourself")
  })

  it("a caller inside the site's consent code (not in the job's files) is never an edit place, and gets no import", () => {
    const helperAt = { file: "src/analytics/events.ts", line: 22 }
    const entry: EventInventoryEntry = { ...VIEW_ITEM, sites: [{ file: "components/ConsentNotice.tsx", line: 6, via: "helper:viewItem", navigation: "full_load", navigationVia: "location.assign", helperAt }] }
    const brief = buildBrief([item("meta_improve:commerce_events", [entry], ["src/analytics/events.ts"])], facts)
    const job = jobText(brief, "meta_improve:commerce_events")
    expect(job).toContain("Its caller: components/ConsentNotice.tsx:6 leaves with a full page load (location.assign): leave it as it is: it is in your consent code, outside this job's files.")
    expect(job).toContain('Import lines, as written: src/analytics/events.ts: `import { infiniteTrackBeforeLeaving } from "../../lib/infinite-analytics"`.')
    expect(job).not.toContain("components/ConsentNotice.tsx: `import")
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
    const job = jobText(brief, "meta_improve:commerce_events")
    expect(job).toContain('It fires inline in a click handler at components/BuyButton.tsx:9 (gtag), not through a helper, and leaves with a full page load (location.href =): replace the handler\'s own navigation with `infiniteTrackThenNavigate(event, <where the click goes>, "add_to_cart", <product>, { destinations: ["meta", "infinite"] })`.')
    expect(job).toContain(`It fires inline in a click handler at components/QuickAdd.tsx:14 (gtag), not through a helper, and does not leave the page: add \`${META_CALL("infiniteTrack")}\` beside the site's own send.`)
    expect(job).toContain('Import lines, as written: components/BuyButton.tsx: `import { infiniteTrackThenNavigate } from "../lib/infinite-analytics"`; components/QuickAdd.tsx: `import { infiniteTrack } from "../lib/infinite-analytics"`.')
  })

  it("Finding 4: a plain link or a form that posts leaves by itself: preventDefault first, then go is location.assign(href) / form.submit()", () => {
    const helperAt = { file: "src/analytics/events.ts", line: 27 }
    const entry: EventInventoryEntry = {
      ...ADD_TO_CART,
      sites: [
        { file: "pages/index.tsx", line: 17, via: "helper:addToCart", navigation: "full_load", navigationVia: "a plain link", leavesBy: "link", helperAt },
        { file: "pages/quick.tsx", line: 9, via: "helper:addToCart", navigation: "full_load", navigationVia: "a form post", leavesBy: "form", helperAt }
      ]
    }
    const brief = buildBrief([item("meta_improve:commerce_events", [entry], ["pages/index.tsx", "pages/quick.tsx", "src/analytics/events.ts"])], facts)
    const job = jobText(brief, "meta_improve:commerce_events")
    expect(job).toContain("pages/index.tsx:17 leaves with a full page load (a plain link): wrap this click handler: its link leaves by itself, so the handler first calls `event.preventDefault()` (add the event parameter if it has none), then `infiniteLeaveAfter(() => { <everything the handler did>; return addToCart(…) }, () => window.location.assign(<the link's href>))`.")
    expect(job).toContain("pages/quick.tsx:9 leaves with a full page load (a form post): wrap this click handler: its form leaves by itself, so the handler first calls `event.preventDefault()` (add the event parameter if it has none), keeps the form (`const form = event.currentTarget`, or `event.currentTarget.form` for a button), then `infiniteLeaveAfter(() => { <everything the handler did>; return addToCart(…) }, () => form.submit())`.")
    expect(job).toContain("Never leave `go` empty")
    // Inline on a link: the tag's own wait, the same way out.
    const inline: EventInventoryEntry = { ...ADD_TO_CART, sites: [{ file: "components/Buy.tsx", line: 5, via: "gtag", navigation: "full_load", navigationVia: "a plain link", leavesBy: "link" }] }
    const only = jobText(buildBrief([item("meta_improve:commerce_events", [inline], ["components/Buy.tsx"])], facts), "meta_improve:commerce_events")
    expect(only).toContain(`and leaves with a full page load (a plain link): call \`event.preventDefault()\` first (the link leaves by itself), then \`infiniteLeaveAfter(() => ${META_CALL("infiniteTrackBeforeLeaving")}, () => window.location.assign(<the link's href>))\`.`)
    expect(only).toContain('components/Buy.tsx: `import { infiniteTrackBeforeLeaving, infiniteLeaveAfter } from "../lib/infinite-analytics"`')
  })

  it("Finding 4: unknown says so and how to tell; it is never \"it does not leave the page\"", () => {
    const entry: EventInventoryEntry = { ...ADD_TO_CART, sites: [{ file: "pages/index.tsx", line: 17, via: "helper:addToCart", helperAt: { file: "src/analytics/events.ts", line: 27 } }] }
    const brief = buildBrief([item("meta_improve:commerce_events", [entry], ["pages/index.tsx", "src/analytics/events.ts"])], facts)
    const job = jobText(brief, "meta_improve:commerce_events")
    expect(job).toContain("Its caller: pages/index.tsx:17 leaves in a way the scan could not tell: tell how it leaves yourself (see below) and write that row's shape.")
    expect(job).not.toContain("does not leave the page")
    // The full table, so a link or a posting form gets its preventDefault row.
    expect(job).toContain("| A plain link (`<a href>`, or a button inside one) or a form that posts: it leaves by itself | The handler first calls `event.preventDefault()`")
    expect(job).toContain("Where the scan could not tell how a click leaves, tell it apart yourself")
  })

  it("P3: an inline send whose router call the site's own hook turns into a full load keeps the router call (never a location.assign)", () => {
    const entry: EventInventoryEntry = { ...ADD_TO_CART, sites: [{ file: "components/Buy.tsx", line: 5, via: "gtag", navigation: "full_load", navigationVia: 'router.push("/cart"), which the site turns into a full page load (pages/_app.tsx:7)', leavesBy: "route_hook" }] }
    const job = jobText(buildBrief([item("meta_improve:commerce_events", [entry], ["components/Buy.tsx"])], facts), "meta_improve:commerce_events")
    expect(job).toContain(`: wrap the handler's own router call, unchanged: \`infiniteLeaveAfter(() => ${META_CALL("infiniteTrackBeforeLeaving")}, () => <its own router call, exactly as written>)\`.`)
    expect(job).not.toContain("`infiniteTrackThenNavigate(event")
    expect(job).toContain("| A router call that the site's own route-change hook turns into a full page load |")
    expect(job).toContain('Import lines, as written: components/Buy.tsx: `import { infiniteTrackBeforeLeaving, infiniteLeaveAfter } from "../lib/infinite-analytics"`.')
  })

  it("a GA4 job names GA4 only, and a PostHog job PostHog only", () => {
    const brief = buildBrief(
      [
        item("ga4_improve:commerce_events", [{ ...ADD_TO_CART, missing: ["ga4"], tools: { posthog: ADD_TO_CART.tools.posthog } }], ["lib/store-events.ts"]),
        item("posthog_improve:commerce_events", [VIEW_ITEM], ["lib/store-events.ts"])
      ],
      facts
    )
    expect(jobText(brief, "ga4_improve:commerce_events")).toContain('infiniteTrack("add_to_cart", <product>, { destinations: ["ga4"] })')
    expect(jobText(brief, "ga4_improve:commerce_events")).not.toContain('"meta"')
    expect(jobText(brief, "posthog_improve:commerce_events")).toContain('infiniteTrack("view_item", <product>, { destinations: ["posthog"] })')
    expect(brief).toContain("(4. Adding GA4 add_to_cart with product and price)")
    expect(brief).toContain("(3. Adding PostHog view_item with product and price)")
    // Two jobs at one place: one call with both tools.
    expect(brief).toContain("make it ONE call with both tools in destinations")
  })

  it("never instructs a browser Meta purchase: a server-only event in a Meta commerce item is dropped", () => {
    const brief = buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART, { ...PURCHASE, missing: ["meta_browser"] }], ["lib/store-events.ts"])], facts)
    const job = jobText(brief, "meta_improve:commerce_events")
    expect(job).toContain("- `add_to_cart` (Meta AddToCart).")
    expect(job).not.toMatch(/`purchase`|Meta Purchase/)
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

describe("the silent form job agrees with the helper rule and with its own finding (live run 6)", () => {
  const silent = {
    id: "setup_check_fixes:silent_form",
    jobId: "setup_check_fixes",
    n: 11,
    title: "Fix the setup-check findings: silent_form",
    owner: "agent",
    trigger: { finding: "Worth checking: the <form> at pages/mailing-list.tsx:58 submits and no conversion marking was found. An existing success handler may already report it. Check that handler before adding anything.", evidence: [{ file: "pages/mailing-list.tsx", line: 58 }] },
    allow: { files: ["pages/mailing-list.tsx"], create: [] },
    checks: [],
    state: "pending"
  } as unknown as ChecklistItem

  it("checks the existing handler first, adds only GA4 / PostHog for a server conversion, and marks the form", () => {
    const brief = buildBrief([silent], { ...facts, plan: { conversionNames: ["begin_checkout", "lead", "purchase"], privacyText: null, lines: [] } })
    const job = jobText(brief, "setup_check_fixes:silent_form")
    expect(job).toContain("What: Make the form the setup check found send its conversion once, only after its request succeeds.")
    expect(job).toContain("first read the form's submit handler and any handler it calls. If its success branch already sends this conversion, leave the handler as it is.")
    expect(job).toContain('`{ destinations: ["ga4", "posthog"] }` at most, because Meta and Infinite get those from your server')
    expect(job).toContain('put `data-conversion="<that same name>"` on the <form> itself (a marker alone sends nothing)')
    // Never "fix exactly what the check found" (it said "check the handler first"), never a second, conflicting template.
    expect(job).not.toContain("Fix exactly what the setup check found")
    expect(job).not.toContain("acceptedShape")
    expect(planData(brief, "setup_check_fixes:silent_form")).toEqual({ approvedConversionNames: ["begin_checkout", "lead", "purchase"], helperImport: 'import { infiniteTrack, infiniteTrackThenNavigate } from "../lib/infinite-analytics"' })
    // The preamble's helper rule says the same: Meta and Infinite only from the server, GA4 / PostHog may be added.
    expect(brief).toContain("never send them to Meta or Infinite with these helpers (a job may still add GA4 or PostHog for them, through `destinations`)")
  })
})

describe("titles and the helper API say what we are doing", () => {
  it("titles name the tool and the events", () => {
    expect(commerceJobTitle("meta_browser", ["view_item", "add_to_cart"])).toBe("Adding Meta AddToCart and ViewContent with product and price")
    expect(commerceJobTitle("ga4", ["begin_checkout"])).toBe("Adding GA4 begin_checkout with product and price")
  })

  it("the helper API documents destinations, the ad-match signal and that conversions are the server's", () => {
    expect(HELPER_API).toContain('`["meta"]` = Meta only')
    expect(HELPER_API).toContain("infiniteAdMatchAllowed()")
    // Live run 6: the server rule names Meta and Infinite precisely, so a job adding GA4 / PostHog never contradicts it.
    expect(HELPER_API).toContain("Purchases, checkout starts and leads reach Meta and Infinite only from your server: never send them to Meta or Infinite with these helpers (a job may still add GA4 or PostHog for them, through `destinations`).")
    expect(HELPER_API).toContain("it never builds a Meta eventID")
  })

  it("the brief lists only the helpers its jobs use, and always the server rule", () => {
    const brief = buildBrief([item("meta_improve:commerce_events", [ADD_TO_CART], ["lib/store-events.ts", "pages/index.tsx", "pages/trail-pack.tsx"])], facts)
    const preamble = brief.slice(0, brief.indexOf("## Jobs"))
    expect(preamble).toContain("- `infiniteTrack(name, props?, options?)`")
    expect(preamble).not.toContain("- `infiniteMetaMirror(")
    expect(preamble).toContain("Purchases, checkout starts and leads reach Meta and Infinite only from your server")
  })
})
