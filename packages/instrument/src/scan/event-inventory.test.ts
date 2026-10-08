// The event × tool inventory (P0-4): where a site's funnel events fire and which tools already get each one, read from
// the site's own code. Two store fixtures shaped like the first store customer (both invented): a one-level sender
// (`sendGa(name)` → `ensureGtag()("event", name)`) and a two-level chain (`track(name)` → `trackGoogleEvent(name)` →
// `gtag?.("event", name)`), each with Stripe Checkout and no payment webhook, a mailing list, and a pixel-free route list.
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { detectOutcomes } from "../jobs/detectors/outcomes.js"
import { loadRepoSnapshot, snapshotFromFiles } from "../jobs/repo-files.js"
import { buildEventInventory, funnelEventOf, inventoryEntry, type EventInventory } from "./event-inventory.js"

const fixture = (name: string) => fileURLToPath(new URL(`../../test/scan/fixtures/${name}`, import.meta.url))
const inventoryOf = (name: string): EventInventory => buildEventInventory(loadRepoSnapshot(fixture(name), "."))
const inline = (files: Record<string, string>): EventInventory => buildEventInventory(snapshotFromFiles(files))

describe("the store with a one-level sender (store-halden)", () => {
  const inventory = inventoryOf("store-halden")

  it("finds view_item, add_to_cart, begin_checkout, purchase and lead, each with the tools that already get it", () => {
    expect(inventory.events).toEqual([
      {
        event: "view_item",
        sites: [{ file: "pages/products/[slug].tsx", line: 21, via: "helper:viewItem" }],
        tools: { ga4: [{ file: "src/analytics/events.ts", line: 23, via: "helper:sendGa" }], posthog: [{ file: "src/analytics/events.ts", line: 24, via: "helper:capturePosthog" }] },
        missing: ["meta_browser"]
      },
      {
        event: "add_to_cart",
        sites: [
          { file: "pages/index.tsx", line: 17, via: "helper:addToCart" },
          { file: "pages/products/[slug].tsx", line: 29, via: "helper:addToCart" }
        ],
        tools: { ga4: [{ file: "src/analytics/events.ts", line: 28, via: "helper:sendGa" }], posthog: [{ file: "src/analytics/events.ts", line: 29, via: "helper:capturePosthog" }] },
        missing: ["meta_browser"]
      },
      {
        event: "begin_checkout",
        sites: [
          { file: "pages/api/checkout.ts", line: 67, via: "stripe.checkout.sessions.create" },
          { file: "pages/cart.tsx", line: 68, via: "helper:beginCheckout" }
        ],
        tools: { ga4: [{ file: "src/analytics/events.ts", line: 33, via: "helper:sendGa" }], posthog: [{ file: "src/analytics/events.ts", line: 34, via: "helper:capturePosthog" }] },
        missing: ["meta_server", "infinite"]
      },
      {
        event: "purchase",
        sites: [{ file: "pages/success.tsx", line: 28, via: "helper:purchase" }],
        tools: { ga4: [{ file: "src/analytics/events.ts", line: 41, via: "helper:sendGa" }], posthog: [{ file: "src/analytics/events.ts", line: 45, via: "helper:capturePosthog" }] },
        missing: ["meta_server", "infinite"]
      },
      {
        event: "lead",
        sites: [
          { file: "pages/api/mailing-list.ts", line: 11, via: "form-api" },
          { file: "pages/mailing-list.tsx", line: 38, via: "helper:generateLead" }
        ],
        tools: { ga4: [{ file: "src/analytics/events.ts", line: 52, via: "helper:sendGa" }], posthog: [{ file: "src/analytics/events.ts", line: 53, via: "helper:capturePosthog" }] },
        missing: ["meta_server", "infinite"]
      }
    ])
  })

  it("sees the checkout session the server creates, that no payment webhook exists, and the routes the pixel is kept off", () => {
    expect(inventory.checkoutCreates).toEqual([{ file: "pages/api/checkout.ts", line: 67, via: "stripe.checkout.sessions.create" }])
    expect(inventory.paymentWebhook).toBeNull()
    expect(inventory.pixelRestrictedRoutes).toEqual(["/cart", "/mailing-list", "/success"])
  })
})

describe("the store with a two-level sender chain (store-chain)", () => {
  const inventory = inventoryOf("store-chain")

  it("follows track → trackGoogleEvent → gtag?.() and capturePostHog → posthog.capture across files", () => {
    expect(inventoryEntry(inventory, "add_to_cart")?.tools).toEqual({
      ga4: [{ file: "src/common/analytics.ts", line: 15, via: "helper:track" }],
      posthog: [{ file: "src/common/analytics.ts", line: 16, via: "helper:capturePostHog" }]
    })
    // Every Buy button and the auto-add landing page fire it.
    expect(inventoryEntry(inventory, "add_to_cart")?.sites.map((site) => `${site.file}:${site.line}`)).toEqual(["pages/index.tsx:7", "pages/index.tsx:11", "pages/preorder.tsx:7"])
  })

  it("view_item goes to GA4 only, so PostHog and Meta miss it", () => {
    expect(inventoryEntry(inventory, "view_item")).toMatchObject({ sites: [{ file: "components/ConsentNotice.tsx", line: 6 }], missing: ["posthog", "meta_browser"] })
  })

  it("finds the server begin_checkout, a purchase with no webhook, and the mailing-list lead (provider call and form)", () => {
    expect(inventory.events.map((entry) => entry.event)).toEqual(["view_item", "add_to_cart", "begin_checkout", "purchase", "lead"])
    expect(inventory.checkoutCreates).toEqual([{ file: "pages/api/checkout.ts", line: 14, via: "stripe.checkout.sessions.create" }])
    expect(inventory.paymentWebhook).toBeNull()
    expect(inventoryEntry(inventory, "purchase")).toMatchObject({ sites: [{ file: "pages/success.tsx", line: 13 }], missing: ["meta_server", "infinite"] })
    expect(inventoryEntry(inventory, "lead")?.sites).toEqual([
      { file: "components/MailingListForm.tsx", line: 11, via: "helper:generateLead" },
      { file: "pages/api/mailing-list.ts", line: 7, via: "form-api" }
    ])
    expect(inventory.pixelRestrictedRoutes).toEqual(["/cart", "/preorder", "/success"])
  })
})

describe("names", () => {
  it.each([
    ["product_added_to_cart", "add_to_cart"],
    ["product_added", "add_to_cart"],
    ["AddToCart", "add_to_cart"],
    ["checkout_started", "begin_checkout"],
    ["InitiateCheckout", "begin_checkout"],
    ["purchase_completed", "purchase"],
    ["Order Completed", "purchase"],
    ["mailing_list_joined", "lead"],
    ["generate_lead", "lead"],
    ["product_viewed", "view_item"],
    ["ViewContent", "view_item"],
    ["CompleteRegistration", "sign_up"],
    ["trial_started", "start_trial"]
  ])("%s means %s", (name, event) => {
    expect(funnelEventOf(name)).toBe(event)
  })

  it.each(["$pageview", "page_view", "faq_open", "cta_click", "PageView"])("%s is not a funnel event", (name) => {
    expect(funnelEventOf(name)).toBeNull()
  })
})

describe("direct sends", () => {
  it("counts fbq standard events as Meta browser, dataLayer events as GA4, and Infinite outcomes as Infinite and Meta server", () => {
    const inventory = inline({
      "app/product/page.tsx": "'use client'\nexport default function P() {\n  fbq('track', 'ViewContent', { content_ids: ['a'] })\n  window.dataLayer.push({ event: 'view_item', ecommerce: {} })\n  return null\n}\n",
      "app/api/stripe/webhook/route.ts":
        "export async function POST(req) {\n  const event = stripe.webhooks.constructEvent(body, sig, secret)\n  if (event.type === 'checkout.session.completed') {\n    await reportInfiniteOutcome({ type: 'purchase', eventId: 'purchase:' + id, path: '/' })\n  }\n}\n"
    })
    expect(inventoryEntry(inventory, "view_item")).toMatchObject({
      tools: { ga4: [{ file: "app/product/page.tsx", line: 4, via: "dataLayer" }], meta_browser: [{ file: "app/product/page.tsx", line: 3, via: "fbq" }] },
      missing: ["posthog"]
    })
    expect(inventory.paymentWebhook).toEqual({ file: "app/api/stripe/webhook/route.ts", line: 2, via: "payment-webhook" })
    expect(inventoryEntry(inventory, "purchase")).toMatchObject({
      tools: { infinite: [{ via: "reportInfiniteOutcome" }], meta_server: [{ via: "reportInfiniteOutcome" }] },
      missing: ["ga4", "posthog"]
    })
  })

  it("reads infiniteTrack's destinations: a Meta-only call does not count as GA4 or PostHog", () => {
    const inventory = inline({
      "components/buy.tsx": "export function Buy() {\n  return <button onClick={() => infiniteTrack('add_to_cart', { value: 1 }, { destinations: { meta: true, ga4: false, posthog: false } })}>Buy</button>\n}\n"
    })
    expect(inventoryEntry(inventory, "add_to_cart")).toMatchObject({ tools: { meta_browser: [{ via: "infiniteTrack" }] }, missing: ["ga4", "posthog"] })
  })

  it("NEGATIVE: comments, strings and test files are never sends", () => {
    const inventory = inline({
      "lib/notes.ts": "// gtag('event', 'purchase')\nconst example = \"posthog.capture('purchase')\"\n",
      "lib/__tests__/cart.test.ts": "gtag('event', 'add_to_cart')\n",
      "tests/fixtures/site.ts": "fbq('track', 'AddToCart')\n"
    })
    expect(inventory.events).toEqual([])
  })

  it("a sender whose name argument is a parameter forwards the tools it reaches, through a getter too", () => {
    const inventory = inline({
      "lib/ga.ts": "function ensureGtag() { return window.gtag }\nexport function sendGa(eventName: string, params: object) {\n  ensureGtag()(\"event\", eventName, params)\n}\n",
      "pages/thanks.tsx": "import { sendGa } from '../lib/ga'\nexport default function Thanks() {\n  sendGa('purchase', { transaction_id: id })\n  return null\n}\n"
    })
    expect(inventoryEntry(inventory, "purchase")).toMatchObject({
      sites: [{ file: "pages/thanks.tsx", line: 3, via: "helper:sendGa" }],
      tools: { ga4: [{ file: "pages/thanks.tsx", line: 3, via: "helper:sendGa" }] }
    })
  })

  it("NEGATIVE: a function of the same name in another file that does not import the sender is not a send", () => {
    const inventory = inline({
      "lib/ga.ts": "export function track(name: string) {\n  gtag('event', name)\n}\n",
      "lib/other.ts": "function track(name: string) {\n  console.log(name)\n}\ntrack('purchase')\n"
    })
    expect(inventory.events).toEqual([])
  })
})

describe("server facts", () => {
  it("a signup or mailing-list API route counts by its path even before it stores anything", () => {
    const snapshot = snapshotFromFiles({
      "pages/api/newsletter.ts": "export default function handler(req, res) {\n  console.log('subscribed')\n  res.status(200).json({ ok: true })\n}\n",
      "app/api/signup/route.ts": "export async function POST(req) {\n  return Response.json({ ok: true })\n}\n",
      "pages/api/products.ts": "export default function handler(req, res) { res.json([]) }\n"
    })
    expect(detectOutcomes(snapshot).map((finding) => [finding.file, finding.kind, finding.detail])).toEqual([
      ["app/api/signup/route.ts", "signup", "signup API route"],
      ["pages/api/newsletter.ts", "lead", "lead API route"]
    ])
    const inventory = buildEventInventory(snapshot)
    expect(inventoryEntry(inventory, "lead")?.sites).toEqual([{ file: "pages/api/newsletter.ts", line: 1, via: "form-api" }])
    expect(inventoryEntry(inventory, "sign_up")?.sites).toEqual([{ file: "app/api/signup/route.ts", line: 1, via: "form-api" }])
  })

  it("NEGATIVE: a checkout session created in browser code is not a server checkout", () => {
    const inventory = inline({ "components/checkout.tsx": "export const go = () => stripe.checkout.sessions.create({})\n" })
    expect(inventory.checkoutCreates).toEqual([])
  })
})
