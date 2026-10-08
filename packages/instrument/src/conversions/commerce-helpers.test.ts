// The managed helpers for store events, EXECUTED in a vm browser with a virtual clock: send ONLY the tools a call
// site is missing (review P0-5 / P1-7), Meta's content keys with a currency and nothing else (review P2), the bounded
// wait for Meta's request before leaving, one navigation at a time, the "visitor allowed tracking" signal (gap 4), and
// the browser leg's match data (gap 5). Ported from the reference store's hand-built fix (its `trackMetaEvent`,
// `trackMetaEventBeforeLeaving` and `createMetaLeave`), with invented product names.
import { describe, expect, it } from "vitest"

import { createBrowserVm, plain } from "../../test/site-code/browser-vm.js"

import { buildConversionHelpersScript, type ConversionHelpersOptions } from "./globals.js"

const PIXEL = "1116400780828774"
const OTHER_PIXEL = "0000000000000001"
const PRODUCT = "{ item_id: 'sku_2', item_name: 'Trail Pack', price: 249, quantity: 1 }"

function store(options: { helpers?: Partial<ConversionHelpersOptions>; ga4?: "managed" | false; gtagCallback?: boolean } = {}) {
  const vm = createBrowserVm({ url: "https://acme.com/" })
  const calls = { posthog: [] as unknown[][], gtag: [] as unknown[][], fbq: [] as unknown[][], infinite: [] as unknown[][] }
  vm.window.posthog = { capture: (...args: unknown[]) => void calls.posthog.push(args) }
  if (options.ga4 !== false) {
    vm.window.gtag = (...args: unknown[]) => {
      calls.gtag.push(args)
      const params = args[2] as { event_callback?: () => void } | undefined
      if (options.gtagCallback && typeof params?.event_callback === "function") params.event_callback()
    }
    vm.window.__infiniteGa4Lane = { id: "G-TEST123" }
  }
  vm.window.fbq = (...args: unknown[]) => void calls.fbq.push(args)
  vm.window.__infiniteRecordEvent = (...args: unknown[]) => {
    calls.infinite.push(args)
    return true
  }
  vm.runScript(buildConversionHelpersScript({ consentMode: "not_required", ownHosts: ["acme.com"], metaPixelId: PIXEL, ...options.helpers }))
  expect(vm.scriptErrors).toEqual([])
  const click = () => {
    const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault() { event.defaultPrevented = true } }
    return event
  }
  return { vm, calls, click }
}

describe("infiniteTrack sends to exactly the tools the call site is missing", () => {
  it("destinations: ['meta'] sends Meta's AddToCart alone (the site already sends GA4 and PostHog there)", () => {
    const page = store({ helpers: { currency: "USD" } })
    expect(page.vm.evaluate(`infiniteTrack('add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)).toBe(true)
    expect(page.calls.posthog).toEqual([])
    expect(page.calls.gtag).toEqual([])
    expect(page.calls.infinite).toEqual([])
    expect(plain(page.calls.fbq)).toEqual([
      ["track", "AddToCart", { content_ids: ["sku_2"], content_name: "Trail Pack", content_type: "product", contents: [{ id: "sku_2", quantity: 1, item_price: 249 }], value: 249, currency: "USD" }]
    ])
  })

  it("any subset works: ['meta', 'posthog'] and the object form ({ ga4: false })", () => {
    const page = store({ helpers: { currency: "USD" } })
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta', 'posthog'] })`)
    expect(page.calls.fbq.map((call) => call[1])).toEqual(["ViewContent"])
    expect(page.calls.posthog.map((call) => call[0])).toEqual(["view_item"])
    expect(page.calls.gtag).toEqual([])
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: { ga4: false } })`)
    expect(page.calls.gtag).toEqual([])
    expect(page.calls.fbq).toHaveLength(2)
    expect(page.calls.infinite).toEqual([["view_item"]])
  })

  it("a custom click goes to Meta as trackCustom only when Meta is named, and never with an eventID", () => {
    const page = store()
    page.vm.evaluate("infiniteTrack('preorder_cta', { cta_location: 'hero' }, { destinations: ['meta'] })")
    expect(plain(page.calls.fbq)).toEqual([["trackCustom", "preorder_cta", { cta_location: "hero" }]])
    page.vm.evaluate("infiniteTrack('preorder_cta', { cta_location: 'hero' }, { destinations: ['posthog'] })")
    expect(page.calls.fbq).toHaveLength(1)
  })

  it("never fires a server-twin conversion to Meta from the page, even when Meta is named", () => {
    const page = store()
    for (const name of ["purchase", "begin_checkout", "lead", "sign_up"]) page.vm.evaluate(`infiniteTrack('${name}', {}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toEqual([])
  })
})

describe("currency on product events (review P2)", () => {
  it("defaults to the site's currency when the caller passes none, on Meta and GA4 alike", () => {
    const page = store({ helpers: { currency: "EUR" } })
    page.vm.evaluate(`infiniteTrack('add_to_cart', ${PRODUCT})`)
    expect(plain(page.calls.fbq[0]![2])).toMatchObject({ value: 249, currency: "EUR" })
    expect(plain(page.calls.gtag[0]![2])).toMatchObject({ value: 249, currency: "EUR", items: [{ item_id: "sku_2", price: 249, quantity: 1 }] })
  })

  it("the caller's currency wins, in any case", () => {
    const page = store({ helpers: { currency: "EUR" } })
    page.vm.evaluate("infiniteTrack('add_to_cart', { item_id: 'sku_2', price: 249, currency: 'usd' })")
    expect(plain(page.calls.fbq[0]![2])).toMatchObject({ value: 249, currency: "USD" })
  })

  it("with no currency known, the products still go and a value never goes alone", () => {
    const page = store()
    page.vm.evaluate(`infiniteTrack('add_to_cart', ${PRODUCT})`)
    const meta = plain(page.calls.fbq[0]![2]) as Record<string, unknown>
    expect(meta).toEqual({ content_ids: ["sku_2"], content_name: "Trail Pack", content_type: "product", contents: [{ id: "sku_2", quantity: 1, item_price: 249 }] })
    const ga4 = plain(page.calls.gtag[0]![2]) as Record<string, unknown>
    expect(ga4).not.toHaveProperty("value")
    expect(ga4).not.toHaveProperty("currency")
  })

  it("an invalid site currency is never baked in", () => {
    expect(buildConversionHelpersScript({ currency: "dollars" })).toContain("var INFINITE_SITE_CURRENCY = null;")
    expect(buildConversionHelpersScript({ currency: "GBP" })).toContain('var INFINITE_SITE_CURRENCY = "GBP";')
  })
})

describe("infiniteTrackThenNavigate with destinations (review P1-7)", () => {
  it("Meta only: no GA4 hold, waits for THIS pixel's AddToCart request, then leaves once", async () => {
    const page = store({ helpers: { currency: "USD" }, gtagCallback: false })
    const event = page.click()
    page.vm.window.__event = event
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(event.defaultPrevented).toBe(true)
    expect(page.calls.gtag).toEqual([])
    expect(page.calls.posthog).toEqual([])
    expect(page.calls.fbq.map((call) => call[1])).toEqual(["AddToCart"])
    // Another pixel's request is not this one.
    await page.vm.resourceLoaded(`https://www.facebook.com/tr/?id=${OTHER_PIXEL}&ev=AddToCart`)
    expect(page.vm.assigned).toEqual([])
    await page.vm.resourceLoaded(`https://www.facebook.com/tr/?id=${PIXEL}&ev=AddToCart`)
    expect(page.vm.assigned).toEqual(["https://acme.com/cart"])
    await page.vm.advance(2000)
    expect(page.vm.assigned).toHaveLength(1)
  })

  it("never waits longer than 400 ms for Meta", async () => {
    const page = store({ gtagCallback: false })
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    await page.vm.advance(399)
    expect(page.vm.assigned).toEqual([])
    await page.vm.advance(1)
    expect(page.vm.assigned).toEqual(["https://acme.com/cart"])
  })

  it("with Meta left out, nothing waits on Meta", () => {
    const page = store({ ga4: false })
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['posthog'] })`)
    expect(page.calls.fbq).toEqual([])
    expect(page.vm.assigned).toEqual(["https://acme.com/cart"])
  })

  it("a double click sends one AddToCart and navigates once; the second click is stopped", async () => {
    const page = store({ gtagCallback: false })
    const first = page.click()
    const second = page.click()
    page.vm.window.__first = first
    page.vm.window.__second = second
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__first, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__second, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(second.defaultPrevented).toBe(true)
    expect(page.calls.fbq).toHaveLength(1)
    await page.vm.advance(400)
    expect(page.vm.assigned).toEqual(["https://acme.com/cart"])
  })

  it("a navigation that did not leave frees the button after the grace period", async () => {
    const page = store({ gtagCallback: false })
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    await page.vm.advance(2999)
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toHaveLength(1)
    await page.vm.advance(1)
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toHaveLength(2)
  })

  it("Back restoring the page from the back/forward cache frees the button at once", async () => {
    const page = store({ gtagCallback: false })
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    await page.vm.advance(400)
    page.vm.evaluate("dispatchEvent({ type: 'pageshow', persisted: false })")
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toHaveLength(1)
    page.vm.evaluate("dispatchEvent({ type: 'pageshow', persisted: true })")
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toHaveLength(2)
  })

  it("a new-tab click is never held and never blocks the next click", () => {
    const page = store({ gtagCallback: false })
    const anchor = "({ tagName: 'A', href: 'https://acme.com/cart', getAttribute: function () { return null } })"
    page.vm.window.__event = page.click()
    page.vm.evaluate(`window.__event.metaKey = true; window.__event.currentTarget = ${anchor}`)
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect((page.vm.window.__event as { defaultPrevented: boolean }).defaultPrevented).toBe(false)
    page.vm.window.__event = page.click()
    page.vm.evaluate(`infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toHaveLength(2)
  })
})

describe("infiniteAdMatchAllowed (parity gap 4)", () => {
  it("asks the tag; false wherever the tag is not running", () => {
    const page = store()
    expect(page.vm.evaluate("infiniteAdMatchAllowed()")).toBe(false)
    page.vm.window.__infiniteAdMatchAllowed = () => true
    expect(page.vm.evaluate("infiniteAdMatchAllowed()")).toBe(true)
    page.vm.window.__infiniteAdMatchAllowed = () => {
      throw new Error("broken")
    }
    expect(page.vm.evaluate("infiniteAdMatchAllowed()")).toBe(false)
  })
})

describe("browser-leg match data on the mirror (parity gap 5)", () => {
  it("with metaAdvancedMatching, the mirror re-inits the chosen pixel with hashed em and external_id before its event", async () => {
    const page = store({ helpers: { metaAdvancedMatching: true } })
    expect(typeof page.vm.window.infiniteMetaAdvancedMatch).toBe("function")
    const done = page.vm.evaluate<Promise<void>>("infiniteMetaMirror('Lead', 'lead:abc', { identity: { email: ' Buyer@Example.com ', externalId: 'cus_123' } })")
    await page.vm.advance(10)
    await page.vm.resourceLoaded(`https://www.facebook.com/tr/?id=${PIXEL}&ev=Lead&eid=lead%3Aabc`)
    await done
    const init = page.calls.fbq.find((call) => call[0] === "init")
    expect(init?.[1]).toBe(PIXEL)
    const userData = plain(init?.[2]) as Record<string, string>
    expect(Object.keys(userData).sort()).toEqual(["em", "external_id"])
    expect(userData.em).toMatch(/^[a-f0-9]{64}$/)
    const order = page.calls.fbq.map((call) => call[0])
    expect(order.indexOf("init")).toBeLessThan(order.indexOf("trackSingle"))
    expect(plain(page.calls.fbq.find((call) => call[0] === "trackSingle"))).toEqual(["trackSingle", PIXEL, "Lead", {}, { eventID: "lead:abc" }])
  })

  it("without it the page has no matching accessor (and the mirror still fires, with no identity)", () => {
    const page = store()
    expect(page.vm.window.infiniteMetaAdvancedMatch).toBeUndefined()
  })
})
