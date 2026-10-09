// The managed helpers for store events, EXECUTED in a vm browser with a virtual clock: send ONLY the tools a call
// site is missing (review P0-5 / P1-7), Meta's content keys with a currency and nothing else (review P2), the bounded
// wait for Meta's request before leaving, one navigation at a time, the "visitor allowed tracking" signal (gap 4), and
// the browser leg's match data (gap 5). Ported from the reference store's hand-built fix (its `trackMetaEvent`,
// `trackMetaEventBeforeLeaving` and `createMetaLeave`), with invented product names.
import { describe, expect, it } from "vitest"

import { createBrowserVm, plain } from "../../test/site-code/browser-vm.js"

import { buildConversionHelpersScript, type ConversionHelpersOptions } from "./globals.js"

const PIXEL = "1234567890123456"
const OTHER_PIXEL = "0000000000000001"
const PRODUCT = "{ item_id: 'sku_2', item_name: 'Trail Pack', price: 249, quantity: 1 }"

function store(options: { helpers?: Partial<ConversionHelpersOptions>; ga4?: "managed" | false; gtagCallback?: boolean; fbq?: false } = {}) {
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
  if (options.fbq !== false) vm.window.fbq = (...args: unknown[]) => void calls.fbq.push(args)
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
  // The site's own pixel starting later (its app shell's effect), exactly as its base code defines fbq.
  const startPixel = () => {
    vm.window.fbq = (...args: unknown[]) => void calls.fbq.push(args)
  }
  return { vm, calls, click, startPixel }
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

describe("a Meta event sent before the site's own pixel starts is held for it, not lost", () => {
  // The live run: the product page's effect called view_item BEFORE the app shell's effect started the site's
  // consent-gated pixel (React runs child effects first), so every full page load lost ViewContent.
  it("fbq appearing 1 s later gets the ViewContent once, with its product data", async () => {
    const page = store({ fbq: false, helpers: { currency: "USD" } })
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toEqual([])
    await page.vm.advance(1000)
    page.startPixel()
    await page.vm.advance(200)
    expect(plain(page.calls.fbq)).toEqual([
      ["track", "ViewContent", { content_ids: ["sku_2"], content_name: "Trail Pack", content_type: "product", contents: [{ id: "sku_2", quantity: 1, item_price: 249 }], value: 249, currency: "USD" }]
    ])
    await page.vm.advance(20_000)
    expect(page.calls.fbq).toHaveLength(1)
    expect(page.vm.pendingTimers()).toEqual([])
  })

  it("follow mode: held while the site's pixels have not started, sent once they run", async () => {
    const page = store({ fbq: false })
    page.vm.window.__infiniteConsentAllowed = () => typeof page.vm.window.fbq === "function"
    expect(page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta', 'infinite'] })`)).toBe(false)
    expect(page.calls.infinite).toEqual([])
    await page.vm.advance(600)
    page.startPixel()
    await page.vm.advance(200)
    expect(page.calls.fbq.map((call) => call[1])).toEqual(["ViewContent"])
  })

  it("a pixel that never starts: dropped after 10 s, no error, no timer left behind", async () => {
    const page = store({ fbq: false })
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta'] })`)
    await page.vm.advance(10_000)
    expect(page.vm.pendingTimers()).toEqual([])
    page.startPixel()
    await page.vm.advance(1000)
    expect(page.calls.fbq).toEqual([])
    expect(page.vm.scriptErrors).toEqual([])
  })

  it("a refusal before the pixel starts: never sent (an explicit no, or a recorded denial)", async () => {
    const page = store({ fbq: false })
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta'] })`)
    page.vm.evaluate("dispatchEvent({ type: 'infinite:analytics-consent-change', detail: { granted: false } })")
    page.startPixel()
    await page.vm.advance(1000)
    expect(page.calls.fbq).toEqual([])

    const denied = store({ fbq: false })
    denied.vm.evaluate(`infiniteTrack('add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    denied.vm.localValues.set("infinite_analytics_consent", "denied")
    denied.startPixel()
    await denied.vm.advance(11_000)
    expect(denied.calls.fbq).toEqual([])
  })

  it("a no while the pixel already runs is never held, and neither is a failing gate", async () => {
    const page = store()
    page.vm.localValues.set("infinite_analytics_consent", "denied")
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta'] })`)
    page.vm.localValues.delete("infinite_analytics_consent")
    await page.vm.advance(1000)
    expect(page.calls.fbq).toEqual([])

    const gated = store({ fbq: false })
    gated.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta'], gate: function () { return false } })`)
    gated.startPixel()
    await gated.vm.advance(1000)
    expect(gated.calls.fbq).toEqual([])
  })

  it("a silenced preview pixel drops the held event", async () => {
    const page = store({ fbq: false })
    page.vm.evaluate(`infiniteTrack('view_item', ${PRODUCT}, { destinations: ['meta'] })`)
    page.vm.evaluate("window.fbq = function () { window.__silencedCalls = (window.__silencedCalls || 0) + 1 }; window.fbq.__infiniteSilenced = true")
    await page.vm.advance(1000)
    expect(page.vm.window.__silencedCalls).toBeUndefined()
    expect(page.vm.pendingTimers()).toEqual([])
  })

  it("fbq already there at the call: sent at once, never a second time from the hold", async () => {
    const page = store()
    page.vm.evaluate(`infiniteTrack('add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`)
    expect(page.calls.fbq).toHaveLength(1)
    await page.vm.advance(11_000)
    expect(page.calls.fbq).toHaveLength(1)
    expect(page.vm.pendingTimers()).toEqual([])
  })

  it("infiniteTrackBeforeLeaving with the event held still settles within the 400 ms Meta bound", async () => {
    const page = store({ fbq: false, gtagCallback: false })
    let settled = false
    void page.vm.evaluate<Promise<void>>(`infiniteTrackBeforeLeaving('add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`).then(() => { settled = true })
    await page.vm.advance(399)
    expect(settled).toBe(false)
    await page.vm.advance(1)
    expect(settled).toBe(true)
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

describe("infiniteTrackBeforeLeaving + infiniteLeaveAfter: the site's helper returns the wait, its full-load caller waits (P1-A)", () => {
  it("sends like infiniteTrack and settles once THIS pixel's request is seen, never rejecting", async () => {
    const page = store({ helpers: { currency: "USD" }, gtagCallback: false })
    let settled = false
    const wait = page.vm.evaluate<Promise<void>>(`infiniteTrackBeforeLeaving('add_to_cart', ${PRODUCT}, { destinations: ['meta', 'infinite'] })`)
    void wait.then(() => { settled = true })
    expect(page.calls.fbq.map((call) => call[1])).toEqual(["AddToCart"])
    expect(page.calls.infinite).toEqual([["add_to_cart"]])
    expect(page.calls.gtag).toEqual([])
    await page.vm.resourceLoaded(`https://www.facebook.com/tr/?id=${OTHER_PIXEL}&ev=AddToCart`)
    expect(settled).toBe(false)
    await page.vm.resourceLoaded(`https://www.facebook.com/tr/?id=${PIXEL}&ev=AddToCart`)
    await wait
    expect(settled).toBe(true)
  })

  it("never waits longer than 400 ms for Meta, and settles at once when nothing was sent", async () => {
    const page = store({ gtagCallback: false })
    let settled = false
    void page.vm.evaluate<Promise<void>>(`infiniteTrackBeforeLeaving('add_to_cart', ${PRODUCT}, { destinations: ['meta'] })`).then(() => { settled = true })
    await page.vm.advance(399)
    expect(settled).toBe(false)
    await page.vm.advance(1)
    expect(settled).toBe(true)
    const nothing = page.vm.evaluate<Promise<void>>(`infiniteTrackBeforeLeaving('add_to_cart', ${PRODUCT}, { destinations: ['posthog'] })`)
    let done = false
    void nothing.then(() => { done = true })
    await page.vm.advance(0)
    expect(done).toBe(true)
  })

  it("infiniteLeaveAfter runs the handler, then the handler's OWN navigation once the wait settles; a double click runs nothing twice", async () => {
    const page = store({ gtagCallback: false })
    page.vm.window.__added = 0
    page.vm.window.__went = [] as string[]
    const click = `infiniteLeaveAfter(function () { window.__added += 1; return infiniteTrackBeforeLeaving('add_to_cart', ${PRODUCT}, { destinations: ['meta', 'infinite'] }) }, function () { window.__went.push('/cart') })`
    page.vm.evaluate(click)
    page.vm.evaluate(click)
    expect(page.vm.window.__added).toBe(1)
    expect(page.calls.fbq).toHaveLength(1)
    expect(page.vm.window.__went).toEqual([])
    await page.vm.resourceLoaded(`https://www.facebook.com/tr/?id=${PIXEL}&ev=AddToCart`)
    await page.vm.advance(0)
    expect(page.vm.window.__went).toEqual(["/cart"])
    await page.vm.advance(2000)
    expect(page.vm.window.__went).toEqual(["/cart"])
    // The handler's own navigation is kept: the helper never assigns a location itself.
    expect(page.vm.assigned).toEqual([])
  })

  it("infiniteLeaveAfter frees the button after the grace period and on a back/forward-cache restore", async () => {
    const page = store({ gtagCallback: false })
    page.vm.window.__added = 0
    const click = "infiniteLeaveAfter(function () { window.__added += 1; return null }, function () {})"
    page.vm.evaluate(click)
    page.vm.evaluate(click)
    expect(page.vm.window.__added).toBe(1)
    await page.vm.advance(3000)
    page.vm.evaluate(click)
    expect(page.vm.window.__added).toBe(2)
    page.vm.evaluate("dispatchEvent({ type: 'pageshow', persisted: true })")
    page.vm.evaluate(click)
    expect(page.vm.window.__added).toBe(3)
  })

  it("a handler that throws frees the button and the error reaches the site", () => {
    const page = store()
    expect(() => page.vm.evaluate("infiniteLeaveAfter(function () { throw new Error('cart broke') }, function () {})")).toThrow(/cart broke/)
    page.vm.window.__added = 0
    page.vm.evaluate("infiniteLeaveAfter(function () { window.__added += 1 }, function () {})")
    expect(page.vm.window.__added).toBe(1)
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
    // The identity hash is real WebCrypto (truly async, not on the fake clock): wait for the event itself before
    // the request "loads", or a slow machine fires the load before the mirror watches for it (seen on CI).
    for (let waited = 0; !page.calls.fbq.some((call) => call[0] === "trackSingle") && waited < 3000; waited += 5) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
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
