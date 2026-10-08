// The tag on a real visit across several pages, EXECUTED in a vm: the site's pixel-free routes in follow mode (review
// P1-6), the "visitor allowed tracking" accessor pages pass to their API routes (parity gap 4), and the managed Meta
// pixel's route-change PageViews (parity gap 8).
import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { renderInfiniteBrowserTag } from "./infinite-browser.js"

type SiteWindow = Record<string, unknown>

interface Visit {
  /** One tab's sessionStorage, kept across the pages of a visit (a new tab gets a new one). */
  session: Map<string, string>
  local: Map<string, string>
}

function newVisit(): Visit {
  return { session: new Map(), local: new Map() }
}

function storage(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key)
  }
}

interface PageOptions {
  path: string
  visit?: Visit
  follow?: boolean
  pixelFreePaths?: string[]
  metaPageViews?: boolean
  /** Set the site's pixels up before the tag runs (as a site whose pixels load first). */
  before?: (window: SiteWindow) => void
}

/** One full page load of `https://shop.example<path>` with the tag. */
function load(options: PageOptions) {
  const visit = options.visit ?? newVisit()
  const requests: Array<Record<string, unknown>> = []
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  let tick: (() => void) | null = null
  let url = new URL(`https://shop.example${options.path}`)
  const location = {
    get href() { return url.href },
    get hostname() { return url.hostname },
    get origin() { return url.origin },
    get pathname() { return url.pathname },
    get search() { return url.search },
    protocol: "https:"
  }
  const window: SiteWindow = {
    location,
    localStorage: storage(visit.local),
    sessionStorage: storage(visit.session),
    addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
    dispatchEvent: (event: { type: string }) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
    },
    CustomEvent: class {
      type: string
      detail: unknown
      constructor(type: string, init: { detail: unknown }) {
        this.type = type
        this.detail = init.detail
      }
    },
    setInterval: (callback: () => void) => {
      tick = callback
      return 1
    }
  }
  const history = {
    pushState(_state: unknown, _title: string, next?: string) {
      if (next) url = new URL(next, url)
    },
    replaceState(_state: unknown, _title: string, next?: string) {
      if (next) url = new URL(next, url)
    }
  }
  const context = {
    window,
    document: { referrer: "", cookie: "", addEventListener() {} },
    location,
    history,
    localStorage: storage(visit.local),
    sessionStorage: storage(visit.session),
    navigator: { doNotTrack: "0", globalPrivacyControl: false, sendBeacon: () => false },
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000001" },
    fetch: async (_path: string, init: { body?: string }) => {
      requests.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>)
      return { ok: true }
    },
    setTimeout: (callback: () => void) => (callback(), 1),
    clearTimeout() {},
    URL,
    URLSearchParams,
    Date,
    JSON,
    Math,
    console
  }
  Object.assign(window, context)
  options.before?.(window)
  const tag = renderInfiniteBrowserTag({
    siteSourceKey: "site_0123456789abcdef0123456789abcdef",
    collectPath: "/infinite/ledger",
    respectDnt: true,
    consent: options.follow === false ? { mode: "not_required" } : { mode: "not_required", followSitePixels: ["fbq", "gtag", "posthog", "dataLayer"] },
    productionHosts: ["shop.example"],
    ...(options.pixelFreePaths ? { pixelFreePaths: options.pixelFreePaths } : {}),
    ...(options.metaPageViews ? { metaPageViews: true } : {})
  })
  runInNewContext(tag.replace(/^<script[^>]*>/i, "").replace(/<\/script[^>]*>$/i, ""), context)
  return {
    window,
    history: (window.history as typeof history),
    requests,
    pageViews: () => requests.filter((request) => request.eventName === "site_page_view").map((request) => String(request.url)),
    tick: () => tick?.(),
    leave: () => {
      for (const listener of listeners.get("pagehide") ?? []) listener({ type: "pagehide", persisted: false })
    },
    adMatch: () => (window.__infiniteAdMatchAllowed as () => boolean)(),
    dispatch: (event: unknown) => (window.dispatchEvent as (event: unknown) => void)(event)
  }
}

const startPixels = (window: SiteWindow) => void (window.fbq = () => {})
const PIXEL_FREE = ["/cart", "/success"]

describe("follow mode on the site's pixel-free routes (review P1-6)", () => {
  it("records /cart and /success for a visitor whose site pixels were running on the page before, in the same tab", () => {
    const visit = newVisit()
    const home = load({ path: "/", visit, pixelFreePaths: PIXEL_FREE, before: startPixels })
    home.tick()
    expect(home.pageViews()).toEqual(["https://shop.example/"])
    home.leave()

    // A full page load of the cart: the site never starts its pixels here.
    const cart = load({ path: "/cart", visit, pixelFreePaths: PIXEL_FREE })
    cart.tick()
    expect(cart.pageViews()).toEqual(["https://shop.example/cart/"])
    expect(cart.adMatch()).toBe(true)
    cart.leave()

    const success = load({ path: "/success?session_id=cs_test_1", visit, pixelFreePaths: PIXEL_FREE })
    success.tick()
    expect(success.pageViews()).toEqual(["https://shop.example/success/"])
  })

  it("records nothing for a visitor who lands on a pixel-free route first: the tag cannot know their choice", () => {
    const cart = load({ path: "/cart", pixelFreePaths: PIXEL_FREE })
    cart.tick()
    expect(cart.requests).toEqual([])
    expect(cart.adMatch()).toBe(false)
  })

  it("a new tab does not inherit an earlier tab's decision", () => {
    const visit = newVisit()
    const home = load({ path: "/", visit, pixelFreePaths: PIXEL_FREE, before: startPixels })
    home.tick()
    const otherTab = load({ path: "/cart", visit: { session: new Map(), local: visit.local }, pixelFreePaths: PIXEL_FREE })
    otherTab.tick()
    expect(otherTab.requests).toEqual([])
  })

  it("an explicit no on a pixel-free route (Consent Mode denied, or the site's granted:false) wins over the earlier yes", () => {
    const visit = newVisit()
    load({ path: "/", visit, pixelFreePaths: PIXEL_FREE, before: startPixels }).tick()
    const denied = load({
      path: "/cart",
      visit,
      pixelFreePaths: PIXEL_FREE,
      before: (window) => void (window.dataLayer = [["consent", "update", { analytics_storage: "denied" }]])
    })
    denied.tick()
    expect(denied.requests).toEqual([])
    expect(visit.session.has("infinite_analytics_follow")).toBe(false)

    const again = newVisit()
    load({ path: "/", visit: again, pixelFreePaths: PIXEL_FREE, before: startPixels }).tick()
    const cart = load({ path: "/cart", visit: again, pixelFreePaths: PIXEL_FREE })
    cart.tick()
    expect(cart.pageViews()).toHaveLength(1)
    cart.dispatch({ type: "infinite:analytics-consent-change", detail: { granted: false } })
    cart.tick()
    expect(cart.adMatch()).toBe(false)
    expect(again.session.has("infinite_analytics_follow")).toBe(false)
    expect(again.local.has("infinite_analytics_visitor")).toBe(false)
  })

  it("rejects a pixel-free route that is not a root-relative path", () => {
    expect(() =>
      renderInfiniteBrowserTag({ collectPath: "/infinite/ledger", respectDnt: true, consent: { mode: "not_required" }, productionHosts: ["shop.example"], pixelFreePaths: ["cart?x=1"] })
    ).toThrow(/pixel-free/)
  })
})

describe("window.__infiniteAdMatchAllowed (parity gap 4)", () => {
  it("follows the site's own pixels in follow mode, live (no wait for the next re-check)", () => {
    const page = load({ path: "/" })
    expect(page.adMatch()).toBe(false)
    page.window.fbq = () => {}
    expect(page.adMatch()).toBe(true)
    page.window.dataLayer = [["consent", "update", { analytics_storage: "denied" }]]
    expect(page.adMatch()).toBe(false)
  })
})

describe("managed Meta pixel: one PageView per client-side route change (parity gap 8)", () => {
  function metaPage(metaPageViews: boolean, fbq: ((...args: unknown[]) => void) & { __infiniteSilenced?: boolean } = () => {}) {
    const calls: unknown[][] = []
    const page = load({
      path: "/",
      follow: false,
      metaPageViews,
      before: (window) => {
        const pixel = Object.assign((...args: unknown[]) => {
          calls.push(args)
          fbq(...args)
        }, fbq.__infiniteSilenced ? { __infiniteSilenced: true } : {})
        window.fbq = pixel
      }
    })
    return { page, calls }
  }

  it("sends fbq('track','PageView') on each route change, never on the first load, never twice for one path", () => {
    const { page, calls } = metaPage(true)
    expect(calls).toEqual([])
    page.history.pushState({}, "", "/products/trail-pack")
    page.history.replaceState({}, "", "/products/trail-pack?color=blue")
    page.history.pushState({}, "", "/cart")
    expect(calls).toEqual([
      ["track", "PageView"],
      ["track", "PageView"]
    ])
    expect(page.pageViews()).toEqual(["https://shop.example/", "https://shop.example/products/trail-pack/", "https://shop.example/cart/"])
  })

  it("sends nothing when the site's own code already sends a PageView on route changes (the option is off)", () => {
    const { page, calls } = metaPage(false)
    page.history.pushState({}, "", "/cart")
    expect(calls).toEqual([])
  })
})
