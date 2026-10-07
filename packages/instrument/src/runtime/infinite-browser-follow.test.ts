import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { renderInfiniteBrowserTag } from "./infinite-browser.js"

type SiteWindow = Record<string, unknown>

/** The tag on a site that already runs its own pixels: nothing of the site's exists until the test adds it. */
function follow(options: { followSitePixels?: boolean; stored?: string; gpc?: boolean } = {}) {
  const requests: Array<Record<string, unknown>> = []
  const dispatched: Array<{ type: string; detail: unknown }> = []
  const listeners = new Map<string, (event: unknown) => void>()
  let tick: (() => void) | null = null
  const stored = new Map<string, string>(options.stored ? [["infinite_analytics_consent", options.stored]] : [])
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key)
  }
  const url = new URL("https://shop.example/pricing")
  const location = { href: url.href, hostname: url.hostname, origin: url.origin, pathname: url.pathname, search: url.search }
  const scripts: string[] = []
  const window: SiteWindow = {
    location,
    localStorage: storage,
    sessionStorage: storage,
    addEventListener: (type: string, listener: (event: unknown) => void) => void listeners.set(type, listener),
    dispatchEvent: (event: { type: string; detail: unknown }) => {
      dispatched.push({ type: event.type, detail: event.detail })
      listeners.get(event.type)?.(event)
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
  const context = {
    window,
    document: {
      referrer: "",
      addEventListener() {},
      querySelector: (selector: string) => (scripts.some((src) => selector.includes(src)) ? {} : null)
    },
    location,
    history: { pushState() {}, replaceState() {} },
    localStorage: storage,
    sessionStorage: storage,
    navigator: { doNotTrack: "0", globalPrivacyControl: options.gpc ?? false, sendBeacon: () => false },
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
  const tag = renderInfiniteBrowserTag({
    siteSourceKey: "site_0123456789abcdef0123456789abcdef",
    collectPath: "/infinite/ledger",
    respectDnt: true,
    consent: options.followSitePixels === false ? { mode: "not_required" } : { mode: "not_required", followSitePixels: ["fbq", "gtag", "posthog", "dataLayer"] },
    productionHosts: ["shop.example"]
  })
  runInNewContext(tag.replace(/^<script[^>]*>/i, "").replace(/<\/script[^>]*>$/i, ""), context)
  const allowed = () => (window.__infiniteConsentAllowed as () => boolean)()
  return {
    window,
    requests,
    dispatched,
    stored,
    allowed,
    pageViews: () => requests.filter((request) => JSON.stringify(request).includes("page_view")).length,
    /** The runtime's own re-check, as its timer would run it. */
    tick: () => tick?.(),
    loadScript: (host: string) => void scripts.push(host)
  }
}

describe("the tag follows the site's own pixels", () => {
  it("sends nothing while the site's pixels have not started (a visitor who has not answered, or refused)", () => {
    const page = follow()
    page.tick()
    page.tick()
    expect(page.requests).toEqual([])
    expect(page.allowed()).toBe(false)
  })

  it.each([
    ["the Meta pixel", (window: SiteWindow) => void (window.fbq = () => {})],
    ["gtag", (window: SiteWindow) => void (window.gtag = () => {})],
    ["PostHog", (window: SiteWindow) => void (window.posthog = { __loaded: true })]
  ])("starts, once, when %s starts", (_name, start) => {
    const page = follow()
    start(page.window)
    page.tick()
    page.tick()
    expect(page.allowed()).toBe(true)
    expect(page.pageViews()).toBe(1)
    expect(page.dispatched).toEqual([{ type: "infinite:analytics-consent-change", detail: { granted: true, source: "site-pixels" } }])
  })

  it("starts on load, with no wait, when the site's pixels were already running", () => {
    const page = follow()
    // Nothing ran yet; a site that starts its pixels unconditionally is seen on the first re-check.
    page.window.fbq = () => {}
    page.tick()
    expect(page.pageViews()).toBe(1)
  })

  it("stops when the site withdraws: Consent Mode denied, or PostHog opted out", () => {
    const page = follow()
    page.window.gtag = () => {}
    page.window.dataLayer = [["consent", "default", { analytics_storage: "granted" }]]
    page.tick()
    expect(page.allowed()).toBe(true)
    ;(page.window.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "denied" }])
    page.tick()
    expect(page.allowed()).toBe(false)
    const sent = page.requests.length
    page.tick()
    expect(page.requests.length).toBe(sent)
    // Granted again: the tag starts again.
    ;(page.window.dataLayer as unknown[]).push(["consent", "update", { analytics_storage: "granted" }])
    page.tick()
    expect(page.allowed()).toBe(true)

    const other = follow()
    other.window.posthog = { __loaded: true, has_opted_out_capturing: () => true }
    other.tick()
    expect(other.allowed()).toBe(false)
    expect(other.requests).toEqual([])
  })

  it("a gtag loaded with a denied Consent Mode default does not start the tag", () => {
    const page = follow()
    page.window.gtag = () => {}
    page.window.dataLayer = [["consent", "default", { analytics_storage: "denied" }]]
    page.tick()
    expect(page.allowed()).toBe(false)
    expect(page.requests).toEqual([])
  })

  it("the site's state is the only decision: an older stored yes, an explicit event and DNT/GPC do not change it", () => {
    const stored = follow({ stored: "granted" })
    stored.tick()
    expect(stored.requests).toEqual([])

    const event = follow()
    ;(event.window.dispatchEvent as (event: unknown) => void)({ type: "infinite:analytics-consent-change", detail: { granted: true } })
    event.tick()
    expect(event.allowed()).toBe(false)
    expect(event.stored.size).toBe(0)

    const gpc = follow({ gpc: true })
    gpc.window.fbq = () => {}
    gpc.tick()
    expect(gpc.allowed()).toBe(true)
  })

  it("never calls, wraps or changes anything of the site's", () => {
    const page = follow()
    const calls: string[] = []
    const fbq = () => void calls.push("fbq")
    const gtag = () => void calls.push("gtag")
    const layer: unknown[] = []
    page.window.fbq = fbq
    page.window.gtag = gtag
    page.window.dataLayer = layer
    page.tick()
    expect(calls).toEqual([])
    expect(page.window.fbq).toBe(fbq)
    expect(page.window.gtag).toBe(gtag)
    expect(layer).toEqual([])
  })

  it("without the flag the tag starts on load, exactly as before, and names no provider", () => {
    const page = follow({ followSitePixels: false })
    expect(page.pageViews()).toBe(1)
    expect(page.dispatched).toEqual([])
    const plain = renderInfiniteBrowserTag({ siteSourceKey: "site_0123456789abcdef0123456789abcdef", collectPath: "/infinite/ledger", respectDnt: true, consent: { mode: "not_required" }, productionHosts: ["shop.example"] })
    for (const name of ["fbq", "gtag", "posthog", "dataLayer", "analytics_storage", "opted_out"]) expect(plain, name).not.toContain(name)
  })
})
