// The event × tool inventory (P0-4): where a site's funnel events fire and which tools already get each one, read from
// the site's own code. Two store fixtures shaped like the first store customer (both invented): a one-level sender
// (`sendGa(name)` → `ensureGtag()("event", name)`) and a two-level chain (`track(name)` → `trackGoogleEvent(name)` →
// `gtag?.("event", name)`), each with Stripe Checkout and no payment webhook, a mailing list, and a pixel-free route list.
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { detectOutcomes } from "../jobs/detectors/outcomes.js"
import { loadRepoSnapshot, snapshotFromFiles } from "../jobs/repo-files.js"
import { buildEventInventory, funnelEventOf, inventoryEntry, type EventInventory, type EventSite } from "./event-inventory.js"

const fixture = (name: string) => fileURLToPath(new URL(`../../test/scan/fixtures/${name}`, import.meta.url))
const inventoryOf = (name: string): EventInventory => buildEventInventory(loadRepoSnapshot(fixture(name), "."))
const inline = (files: Record<string, string>): EventInventory => buildEventInventory(snapshotFromFiles(files))
/** A trigger site without what P1-A adds (how its click leaves, where its helper is): asserted on their own below. */
const bare = (site: EventSite): EventSite => ({ file: site.file, line: site.line, via: site.via })
const bareEntries = (entries: EventInventory["events"]) => entries.map((entry) => ({ ...entry, sites: entry.sites.map(bare) }))

describe("the store with a one-level sender (store-halden)", () => {
  const inventory = inventoryOf("store-halden")

  it("finds view_item, add_to_cart, begin_checkout, purchase and lead, each with the tools that already get it", () => {
    expect(bareEntries(inventory.events)).toEqual([
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
    expect(inventoryEntry(inventory, "lead")?.sites.map(bare)).toEqual([
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

describe("the site's currency (one source for the browser helpers' default currency)", () => {
  it("the currency the Stripe Checkout charges in wins; else the one currency the code names; several with no checkout = unknown", () => {
    expect(inventoryOf("store-halden").siteCurrency).toBe("USD")
    const checkout = 'export default async function handler(req, res) {\n  await stripe.checkout.sessions.create({ line_items: [{ price_data: { currency: "eur", unit_amount: 100 } }] })\n}\n'
    expect(inline({ "pages/api/checkout.ts": checkout, "src/price.ts": 'export const fmt = new Intl.NumberFormat("en", { style: "currency", currency: "GBP" })\n' }).siteCurrency).toBe("EUR")
    expect(inline({ "src/price.ts": 'export const fmt = new Intl.NumberFormat("en", { style: "currency", currency: "GBP" })\n' }).siteCurrency).toBe("GBP")
    expect(inline({ "src/a.ts": 'const a = { currency: "GBP" }\n', "src/b.ts": 'const b = { currency: "EUR" }\n' }).siteCurrency).toBeNull()
    // A comment or a string is not the site's currency.
    expect(inline({ "src/a.ts": '// currency: "JPY"\nconst text = "currency: \'JPY\'"\n' }).siteCurrency).toBeNull()
  })

  it("the recipe reporters count as Infinite and Meta-from-the-server sends of their conversion", () => {
    const webhook = 'import { reportStripeCheckoutPurchase } from "../../lib/infinite-outcome"\nexport default async function handler(req, res) {\n  res.status(await reportStripeCheckoutPurchase(event, { path: "/success" })).end()\n}\n'
    const purchase = inventoryEntry(inline({ "pages/api/stripe-webhook.ts": webhook }), "purchase")
    expect(Object.keys(purchase?.tools ?? {}).sort()).toEqual(["infinite", "meta_server"])
  })
})

describe("P1-A: how each Buy click leaves the page", () => {
  const events = `export function addToCart(id: string) {\n  sendGa("add_to_cart", { id })\n}\nfunction sendGa(name: string, params: object) {\n  window.gtag?.("event", name, params)\n}\n`
  const sites = (files: Record<string, string>) => inventoryEntry(inline({ "src/events.ts": events, ...files }), "add_to_cart")!.sites

  it("client routing, a full page load, a form post, a plain link and no navigation are told apart; the helper's place is named", () => {
    const got = sites({
      "pages/a.tsx": `import { addToCart } from "../src/events"\nexport default function A() {\n  const buy = () => {\n    addToCart("a")\n    void router.push("/cart")\n  }\n  return null\n}\n`,
      "pages/b.tsx": `import { addToCart } from "../src/events"\nexport default function B() {\n  const buy = () => {\n    addToCart("b")\n    window.location.assign("/cart")\n  }\n  return null\n}\n`,
      "pages/c.tsx": `import { addToCart } from "../src/events"\nexport default function C() {\n  return <form method="POST" action="/api/cart" onSubmit={() => addToCart("c")}><button>Add</button></form>\n}\n`,
      "pages/d.tsx": `import { addToCart } from "../src/events"\nexport default function D() {\n  return <a href="/cart" onClick={() => addToCart("d")}>Buy</a>\n}\n`,
      "pages/e.tsx": `import { addToCart } from "../src/events"\nexport default function E() {\n  useEffect(() => { addToCart("e") }, [])\n  return null\n}\n`
    })
    expect(got.map((site) => [site.file, site.navigation, site.navigationVia])).toEqual([
      ["pages/a.tsx", "client", 'router.push("/cart")'],
      ["pages/b.tsx", "full_load", "location.assign"],
      ["pages/c.tsx", "full_load", "a form post"],
      ["pages/d.tsx", "full_load", "a plain link"],
      ["pages/e.tsx", "none", "no navigation (it runs when the page loads, not on a click)"]
    ])
    expect(got.map((site) => site.leavesBy)).toEqual([undefined, undefined, "form", "link", undefined])
    expect(new Set(got.map((site) => JSON.stringify(site.helperAt)))).toEqual(new Set([JSON.stringify({ file: "src/events.ts", line: 1 })]))
  })

  it("Finding 4: unknown is never 'does not leave'; named handlers, one helper call and a button inside a link are read", () => {
    const page = (name: string, body: string, jsx: string) => `import { addToCart } from "../src/events"\nexport default function ${name}() {\n${body}\n  return ${jsx}\n}\n`
    const got = sites({
      "pages/a.tsx": page("A", '  const handleBuy = () => { addToCart("a") }', '<a href="/cart" onClick={handleBuy}>Buy</a>'),
      "pages/b.tsx": page("B", '  const onSubmit = () => { addToCart("b") }', '<form method="post" action="/api/cart" onSubmit={onSubmit}><button>Buy</button></form>'),
      "pages/c.tsx": page("C", '  const goToCart = () => { window.location.assign("/cart") }\n  const buy = () => { addToCart("c"); goToCart() }', "<button onClick={buy}>Buy</button>"),
      "pages/d.tsx": page("D", "", '<a href="/cart"><button onClick={() => addToCart("d")}>Buy</button></a>'),
      "pages/e.tsx": page("E", '  const buy = () => { const location = "eu"; addToCart(location) }', "<button onClick={buy}>Buy</button>"),
      "pages/f.tsx": page("F", '  const buy = (e: Event) => { e.preventDefault(); addToCart("f") }', '<a href="/cart" onClick={buy}>Buy</a>')
    })
    expect(got.map((site) => [site.file, site.navigation, site.leavesBy])).toEqual([
      ["pages/a.tsx", "full_load", "link"],
      ["pages/b.tsx", "full_load", "form"],
      ["pages/c.tsx", "full_load", undefined],
      ["pages/d.tsx", "full_load", "link"],
      // A local variable named `location` is not a page load, and seeing no navigation is NOT "does not leave".
      ["pages/e.tsx", undefined, undefined],
      ["pages/f.tsx", "none", undefined]
    ])
    expect(got[2]!.navigationVia).toBe("goToCart(): location.assign")
    // An effect that adds to the cart and then redirects does leave: the written navigation wins over "it runs on load".
    const redirect = sites({ "pages/r.tsx": page("R", '  useEffect(() => {\n    addToCart("r")\n    window.location.replace("/cart")\n  }, [])', "null") })
    expect(redirect.map((site) => [site.file, site.navigation])).toEqual([["pages/r.tsx", "full_load"]])
  })

  it("router navigation the site's own route-change hook turns into a full page load is a full page load (into a pixel-free route)", () => {
    const hook = `const NO_PIXEL_ROUTES = ["/cart"]\nexport function Guard() {\n  useEffect(() => {\n    const force = (url: string) => { window.location.assign(url) }\n    router.events.on("routeChangeStart", force)\n  }, [])\n  return null\n}\n`
    const page = (target: string) => `import { addToCart } from "../src/events"\nexport default function A() {\n  const buy = () => {\n    addToCart("a")\n    void router.push("${target}")\n  }\n  return null\n}\n`
    const inventory = inline({ "src/events.ts": events, "components/Guard.tsx": hook, "pages/a.tsx": page("/cart"), "pages/b.tsx": page("/about") })
    expect(inventory.routeChangeFullLoad).toEqual({ file: "components/Guard.tsx", line: 5, via: "routeChangeStart" })
    const got = inventoryEntry(inventory, "add_to_cart")!.sites
    expect(got.map((site) => [site.file, site.navigation])).toEqual([["pages/a.tsx", "full_load"], ["pages/b.tsx", "client"]])
    expect(got[0]!.navigationVia).toBe('router.push("/cart"), which the site turns into a full page load (components/Guard.tsx:5)')
  })
})

describe("Finding 7: the route-change hook counts only when its own callback does the full load", () => {
  const events = `export function addToCart(id: string) {\n  window.gtag?.("event", "add_to_cart", { id })\n}\n`
  const page = `import { addToCart } from "../src/events"\nexport default function A() {\n  const buy = () => {\n    addToCart("a")\n    void router.push("/cart")\n  }\n  return null\n}\n`
  const hookOf = (app: string) => inline({ "src/events.ts": events, "pages/a.tsx": page, "pages/_app.tsx": app })

  it("a progress bar on routeChangeStart beside an unrelated location.href is not the hook; router.push stays client routing", () => {
    const app = `export default function App() {\n  useEffect(() => {\n    const start = () => document.body.classList.add("loading")\n    router.events.on("routeChangeStart", start)\n  }, [])\n  const signOut = () => { window.location.href = "/" }\n  return null\n}\n`
    const inventory = hookOf(app)
    expect(inventory.routeChangeFullLoad).toBeNull()
    expect(inventoryEntry(inventory, "add_to_cart")!.sites.map((site) => site.navigation)).toEqual(["client"])
  })

  it("a named or inline callback that assigns the location is the hook", () => {
    const named = `export default function App() {\n  useEffect(() => {\n    const hard = (url: string) => { window.location.assign(url) }\n    router.events.on("routeChangeStart", hard)\n  }, [])\n  return null\n}\n`
    expect(hookOf(named).routeChangeFullLoad).toEqual({ file: "pages/_app.tsx", line: 4, via: "routeChangeStart" })
    const inlined = `export default function App() {\n  useEffect(() => {\n    router.events.on("routeChangeStart", (url: string) => { window.location.href = url })\n  }, [])\n  return null\n}\n`
    expect(hookOf(inlined).routeChangeFullLoad).toEqual({ file: "pages/_app.tsx", line: 3, via: "routeChangeStart" })
    expect(inventoryEntry(hookOf(inlined), "add_to_cart")!.sites.map((site) => [site.navigation, site.leavesBy])).toEqual([["full_load", "route_hook"]])
  })
})

describe("P1-B: the page's 'visitor allowed tracking' signal", () => {
  const signal = (files: Record<string, string>) => inline({ "src/events.ts": `export function addToCart() {\n  window.gtag?.("event", "add_to_cart")\n}\n`, ...files }).trackingSignal

  it("names the site's own consent reader, read only: a state reader compared with the site's own 'granted' word", () => {
    expect(signal({
      "src/analytics/tracking.ts": `export type ConsentState = "granted" | "denied" | "unset"\nexport function getConsent(): ConsentState {\n  return (localStorage.getItem("c") as ConsentState) ?? "unset"\n}\nexport function acceptTracking() {}\nexport function setConsent(value: ConsentState) {}\n`
    })).toEqual({ kind: "site_getter", expression: 'getConsent() === "granted"', name: "getConsent", file: "src/analytics/tracking.ts", line: 2 })
  })

  it("prefers a boolean tracking reader; never a setter, an action, or a reader that needs an argument", () => {
    expect(signal({
      "src/consent.ts": `export function readConsent(raw: string) { return raw === "granted" ? "granted" : "denied" }\nexport function trackingAllowed(): boolean {\n  return localStorage.getItem("x") === "yes"\n}\nexport function startTracking() {}\n`,
      "src/state.ts": `export function getCookieConsent(storage?: Storage) { return storage ? "accepted" : null }\n`
    })).toEqual({ kind: "site_getter", expression: "trackingAllowed()", name: "trackingAllowed", file: "src/consent.ts", line: 2 })
  })

  it("Finding 5: a 'has answered' reader is never the signal (it is true for a visitor who said no); unsure falls back to the tag's helper", () => {
    const gate = { "components/CookieBanner.tsx": `export default function CookieBanner() {\n  window.gtag?.("consent", "update", { analytics_storage: "granted" })\n  return null\n}\n` }
    for (const name of ["hasConsentChoice", "isConsentSet", "isCookieBannerOpen", "hasAnsweredConsent", "wasConsentAsked", "consentBannerShown", "isConsentDismissed"]) {
      expect(signal({ ...gate, "src/consent.ts": `export function ${name}(): boolean {\n  return localStorage.getItem("c") !== null\n}\n` }), name).toEqual({ kind: "tag_helper" })
    }
    // A choice-named state reader is refused too.
    expect(signal({ ...gate, "src/consent.ts": `export function consentChoice(): "granted" | "denied" | null {\n  return null\n}\n` })).toEqual({ kind: "tag_helper" })
    // A reader whose own code never says which value means yes: unsure, so not the reader.
    expect(signal({ ...gate, "src/consent.ts": `export function getConsent() {\n  return localStorage.getItem("c")\n}\nexport function grantMode() {\n  window.gtag?.("consent", "update", { ad_storage: "granted" })\n}\n` })).toEqual({ kind: "tag_helper" })
  })

  it("Finding 5: the yes word comes from the reader's own return type, return values or stored values, never the whole file", () => {
    const consentMode = 'export function syncConsentMode() {\n  window.gtag?.("consent", "update", { ad_storage: "granted" })\n}\n'
    expect(signal({ "src/consent.ts": `${consentMode}export function getConsent() {\n  return localStorage.getItem("c") === "1" ? "accepted" : "rejected"\n}\n` })).toMatchObject({ kind: "site_getter", expression: 'getConsent() === "accepted"' })
    expect(signal({ "src/consent.ts": `${consentMode}export function getConsent(): "accepted" | "rejected" | null {\n  return read()\n}\n` })).toMatchObject({ expression: 'getConsent() === "accepted"' })
    expect(signal({ "src/consent.ts": `${consentMode}const KEY = "choice"\nexport function getConsent() {\n  return localStorage.getItem(KEY)\n}\nexport function acceptAll() {\n  localStorage.setItem(KEY, "accepted")\n}\nexport function rejectAll() {\n  localStorage.setItem(KEY, "rejected")\n}\n` })).toMatchObject({ expression: 'getConsent() === "accepted"' })
    // A state-named reader that returns a comparison is a boolean.
    expect(signal({ "src/consent.ts": 'export function getConsent() {\n  return localStorage.getItem("c") === "yes"\n}\n' })).toMatchObject({ expression: "getConsent()" })
  })

  it("is true on a site with no consent gate at all, and the tag's helper where a gate exists but no reader can be imported", () => {
    expect(signal({})).toEqual({ kind: "always" })
    expect(signal({ "components/CookieBanner.tsx": `export default function CookieBanner() {\n  window.gtag?.("consent", "update", { analytics_storage: "granted" })\n  return null\n}\n` })).toEqual({ kind: "tag_helper" })
  })
})

describe("Finding 1: how each page sends its request to the site's own checkout and sign-up routes", () => {
  const checkout = `import Stripe from "stripe"\nexport default async function handler(req, res) {\n  const session = await new Stripe("k").checkout.sessions.create({ mode: "payment" })\n  res.redirect(303, session.url)\n}\n`
  const requests = (pages: Record<string, string>) => inline({ "pages/api/checkout.ts": checkout, ...pages }).pageRequests

  it("a form that posts, a JSON fetch, a GET fetch, a link and a GET form are told apart; a path in a constant is unknown", () => {
    expect(requests({
      "pages/cart.tsx": `export default function Cart() {\n  return <form method="POST" action="/api/checkout"><button>Pay</button></form>\n}\n`,
      "pages/quick.tsx": `export default function Quick() {\n  const go = () => fetch("/api/checkout", { method: "POST", body: JSON.stringify({ sku: "a" }) })\n  return null\n}\n`,
      "pages/peek.tsx": `export default function Peek() {\n  const go = () => fetch(\`/api/checkout?sku=\${"a"}\`)\n  return null\n}\n`,
      "pages/link.tsx": `export default function Link() {\n  return <a href="/api/checkout?sku=a">Buy</a>\n}\n`,
      "pages/get.tsx": `export default function Get() {\n  return <form action="/api/checkout"><button>Pay</button></form>\n}\n`,
      "src/urls.ts": `export const CHECKOUT_URL = "/api/checkout"\n`
    })).toEqual([
      { route: "pages/api/checkout.ts", file: "pages/cart.tsx", line: 2, how: "form", via: "a form that posts" },
      { route: "pages/api/checkout.ts", file: "pages/get.tsx", line: 2, how: "query", via: "a form that sends a GET" },
      { route: "pages/api/checkout.ts", file: "pages/link.tsx", line: 2, how: "query", via: "a link" },
      { route: "pages/api/checkout.ts", file: "pages/peek.tsx", line: 2, how: "query", via: "a GET fetch" },
      { route: "pages/api/checkout.ts", file: "pages/quick.tsx", line: 2, how: "json", via: "a JSON fetch" },
      { route: "pages/api/checkout.ts", file: "src/urls.ts", line: 1, how: "unknown", via: "a request the scan could not read" }
    ])
  })

  it("NEGATIVE: another route that starts with the same path, a comment and server code are not the page's request", () => {
    expect(requests({
      "pages/a.tsx": `// posts to "/api/checkout"\nexport default function A() {\n  return <a href="/api/checkout-help">Help</a>\n}\n`,
      "pages/api/other.ts": `export default function handler(req, res) {\n  res.redirect("/api/checkout")\n}\n`
    })).toEqual([])
  })
})
