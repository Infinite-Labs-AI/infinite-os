// The managed conversion helpers, EXECUTED in a vm browser with a virtual clock.
//
// Ported from infinite-site @ 9f65b47:
//   - `.github/scripts/test-inject-analytics.mjs` L580-595 (the download bridge holds a same-tab click
//     and binds once) and L620-631 (no GA4 → no held click: the F15 dead-button guard);
//   - `.github/scripts/test-get-started-page.mjs` L1278-1311 (`testGetStartedCtaBridge`: consent on and
//     off, revocation stops capture, nothing personal leaks).
// Plus the new cases the build plan requires (§O5): a callback that never fires navigates exactly once
// at 1000 ms, a callback that fires twice navigates once, no tags at all still navigates, the hold
// keys off the GA4 lane MARKER and not `typeof gtag`, and a denied consent hook captures nothing.
import { describe, expect, it } from "vitest"

import { createBrowserVm, plain, type BrowserVmOptions } from "../../test/site-code/browser-vm.js"
import { jsSource } from "../../test/site-code/js-source.js"

import { buildConversionHelpersScript, CONVERSION_HELPER_GLOBALS } from "./globals.js"

type Call = unknown[]

interface Page {
  vm: ReturnType<typeof createBrowserVm>
  posthogCalls: Call[]
  gtagCalls: Call[]
  fbqCalls: Call[]
  click(options?: Partial<ClickEvent>): ClickEvent
  call<T = unknown>(source: string): T
}

interface ClickEvent {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
  preventDefault(): void
}

interface PageOptions extends BrowserVmOptions {
  posthog?: boolean
  /** "managed": gtag + the lane marker (GA4 started); "adopted": gtag without the marker; false: none. */
  ga4?: "managed" | "adopted" | false
  /** How the gtag stub treats event_callback: never call it, call it once, or twice. */
  callback?: "never" | "once" | "twice"
  consentMode?: "required" | "not_required"
}

function page(options: PageOptions = {}): Page {
  const vm = createBrowserVm(options)
  const posthogCalls: Call[] = []
  const gtagCalls: Call[] = []
  const fbqCalls: Call[] = []
  if (options.posthog) {
    vm.window.posthog = {
      capture: (...args: unknown[]) => void posthogCalls.push(["capture", ...args]),
      identify: (...args: unknown[]) => void posthogCalls.push(["identify", ...args]),
      reset: (...args: unknown[]) => void posthogCalls.push(["reset", ...args])
    }
  }
  if (options.ga4) {
    vm.window.gtag = (...args: unknown[]) => {
      gtagCalls.push(args)
      const params = args[2] as { event_callback?: () => void } | undefined
      if (params && typeof params.event_callback === "function") {
        if (options.callback === "once") params.event_callback()
        if (options.callback === "twice") {
          params.event_callback()
          params.event_callback()
        }
      }
    }
    if (options.ga4 === "managed") vm.window.__infiniteGa4Lane = { id: "G-TEST123" }
  }
  vm.window.fbq = (...args: unknown[]) => void fbqCalls.push(args)
  vm.runScript(buildConversionHelpersScript({ consentMode: options.consentMode ?? "not_required", ownHosts: ["acme.com"] }))
  expect(vm.scriptErrors).toEqual([])
  return {
    vm,
    posthogCalls,
    gtagCalls,
    fbqCalls,
    click(overrides = {}) {
      const event: ClickEvent = {
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault() {
          event.defaultPrevented = true
        },
        ...overrides
      }
      return event
    },
    call: (source) => vm.evaluate(source)
  }
}

describe("the helper script", () => {
  it("defines every global once and is inert when loaded twice", () => {
    const p = page()
    for (const name of CONVERSION_HELPER_GLOBALS) expect(typeof p.vm.window[name]).toBe("function")
    const first = p.vm.window.infiniteTrack
    p.vm.runScript(buildConversionHelpersScript({}))
    expect(p.vm.window.infiniteTrack).toBe(first)
  })

  it("emits no backtick, no ${ and no </ (it folds into <script> and the Next string literal)", () => {
    expect(buildConversionHelpersScript({ consentMode: "required", ownHosts: ["acme.com"] })).not.toMatch(/`|\$\{|<\//)
  })
})

describe("infiniteTrack", () => {
  it("sends one named event to PostHog and GA4, and never to Meta", () => {
    const p = page({ posthog: true, ga4: "managed" })
    expect(p.call("infiniteTrack('signup_started', { plan: 'pro', seats: 3, annual: true })")).toBe(true)
    expect(plain(p.posthogCalls)).toEqual([["capture", "signup_started", { plan: "pro", seats: 3, annual: true }]])
    expect(plain(p.gtagCalls)).toEqual([
      ["event", "signup_started", { plan: "pro", seats: 3, annual: true, send_to: "G-TEST123" }]
    ])
    expect(p.fbqCalls).toEqual([])
  })

  it("sends browser-only commerce events to every browser tool with product and money payloads, and no Meta eventID", () => {
    const p = page({ posthog: true, ga4: "managed" })
    const infiniteCalls: Call[] = []
    p.vm.window.__infiniteRecordEvent = (...args: unknown[]) => {
      infiniteCalls.push(args)
      return true
    }
    expect(p.call("infiniteTrack('add_to_cart', { item_id: 'sku_1', item_name: 'Trail Pack', price: 249, quantity: 2, value: 498, currency: 'USD' })")).toBe(true)
    expect(plain(p.posthogCalls)).toEqual([
      ["capture", "add_to_cart", { item_id: "sku_1", item_name: "Trail Pack", price: 249, quantity: 2, value: 498, currency: "USD" }]
    ])
    expect(plain(p.gtagCalls)).toEqual([
      [
        "event",
        "add_to_cart",
        {
          item_id: "sku_1",
          item_name: "Trail Pack",
          price: 249,
          quantity: 2,
          value: 498,
          currency: "USD",
          items: [{ item_id: "sku_1", item_name: "Trail Pack", price: 249, quantity: 2 }],
          send_to: "G-TEST123"
        }
      ]
    ])
    expect(plain(p.fbqCalls)).toEqual([
      [
        "track",
        "AddToCart",
        {
          item_id: "sku_1",
          item_name: "Trail Pack",
          price: 249,
          quantity: 2,
          value: 498,
          currency: "USD",
          content_ids: ["sku_1"],
          content_type: "product",
          contents: [{ id: "sku_1", quantity: 2, item_price: 249 }],
          content_name: "Trail Pack"
        }
      ]
    ])
    expect(plain(infiniteCalls)).toEqual([
      ["add_to_cart", { item_id: "sku_1", item_name: "Trail Pack", price: 249, quantity: 2, value: 498, currency: "USD" }]
    ])
    expect(plain(p.fbqCalls[0]![2] as Record<string, unknown>)).not.toHaveProperty("eventID")
  })

  it("can send a browser-only custom CTA to Meta without an eventID, but never auto-fires server-twin conversions", () => {
    const p = page({ posthog: true })
    expect(p.call("infiniteTrack('hero_cta_clicked', { cta_location: 'hero' }, { destinations: { meta: true } })")).toBe(true)
    expect(plain(p.fbqCalls)).toEqual([["trackCustom", "hero_cta_clicked", { cta_location: "hero" }]])
    p.call("infiniteTrack('sign_up')")
    p.call("infiniteTrack('purchase')")
    expect(plain(p.fbqCalls)).toEqual([["trackCustom", "hero_cta_clicked", { cta_location: "hero" }]])
  })

  it("drops a property that could carry personal data or a click id, and bounds the rest", () => {
    const p = page({ posthog: true })
    const props: Record<string, unknown> = {
      email: "person@example.test",
      nested: "person%2540example.test",
      phone: "+1 (555) 123-4567",
      link: "https://private.example.test",
      click: "x gclid=SECRET",
      long: "a".repeat(101),
      "bad key": "x",
      send_to: "G-EVIL",
      object: { a: 1 },
      infinity: Infinity,
      ok: "spring_sale"
    }
    for (let index = 0; index < 20; index += 1) props[`k${index}`] = index
    p.vm.window.__props = props
    p.call("infiniteTrack('cta_clicked', window.__props)")
    const sent = plain(p.posthogCalls[0]![2]) as Record<string, unknown>
    expect(sent.ok).toBe("spring_sale")
    for (const dropped of ["email", "nested", "phone", "link", "click", "long", "bad key", "send_to", "object", "infinity"]) {
      expect(sent).not.toHaveProperty([dropped])
    }
    expect(Object.keys(sent)).toHaveLength(16)
  })

  it("refuses a bad event name and sends nothing", () => {
    const p = page({ posthog: true, ga4: "managed" })
    for (const name of ["", "has space", "x".repeat(65), "a<b"]) {
      p.vm.window.__name = name
      expect(p.call("infiniteTrack(window.__name)")).toBe(false)
    }
    expect(p.posthogCalls).toEqual([])
    expect(p.gtagCalls).toEqual([])
  })

  it("with no tags present returns false and never throws", () => {
    const p = page()
    expect(p.call("infiniteTrack('cta_clicked', { a: 1 })")).toBe(false)
  })

  it("a denied consent hook captures nothing, and a revocation is honoured on the next call", () => {
    const denied = page({ posthog: true, ga4: "managed", localStorage: { infinite_analytics_consent: "denied" } })
    expect(denied.call("infiniteTrack('cta_clicked')")).toBe(false)
    expect(denied.posthogCalls).toEqual([])
    expect(denied.gtagCalls).toEqual([])

    const p = page({ posthog: true })
    expect(p.call("infiniteTrack('first')")).toBe(true)
    p.vm.localValues.set("infinite_analytics_consent", "denied")
    expect(p.call("infiniteTrack('second')")).toBe(false)
    expect(plain(p.posthogCalls)).toEqual([["capture", "first", {}]])
  })

  it("asks the runtime's own consent check first when the runtime exposes it (without the DNT/GPC default)", () => {
    const p = page({ posthog: true })
    const asked: unknown[] = []
    p.vm.window.__infiniteConsentAllowed = (options: unknown) => {
      asked.push(options)
      return false
    }
    expect(p.call("infiniteTrack('cta_clicked')")).toBe(false)
    p.vm.window.__infiniteConsentAllowed = () => true
    expect(p.call("infiniteTrack('cta_clicked')")).toBe(true)
    expect(plain(asked)).toEqual([{ privacySignal: false }])
  })

  // P2-4: GA4's and PostHog's own page views do not follow DNT/GPC, so a helper that did would drop a GPC
  // browser's conversions while its page views still counted (Brave sends GPC by default): a
  // conversion-rate skew by browser. The visitor's recorded "no" and required mode still stop it.
  it("DNT/GPC alone does not drop a conversion; a recorded no does, and required mode waits for a grant", () => {
    expect(page({ posthog: true, gpc: true }).call("infiniteTrack('x')")).toBe(true)
    expect(page({ posthog: true, dnt: "1" }).call("infiniteTrack('x')")).toBe(true)
    expect(page({ posthog: true, gpc: true, localStorage: { infinite_analytics_consent: "denied" } }).call("infiniteTrack('x')")).toBe(false)
    expect(page({ posthog: true, consentMode: "required" }).call("infiniteTrack('x')")).toBe(false)
    expect(
      page({ posthog: true, consentMode: "required", localStorage: { infinite_analytics_consent: "granted" } }).call(
        "infiniteTrack('x')"
      )
    ).toBe(true)
  })

  it("the site's own gate must also say yes", () => {
    const p = page({ posthog: true })
    expect(p.call("infiniteTrack('x', {}, { gate: function () { return false } })")).toBe(false)
    expect(p.call("infiniteTrack('x', {}, { gate: function () { throw new Error('no') } })")).toBe(false)
    expect(p.call("infiniteTrack('x', {}, { gate: function () { return true } })")).toBe(true)
  })

  it("sends nothing while an OAuth return is in the URL, but a promo ?code= alone is fine", () => {
    expect(page({ posthog: true, url: "https://acme.com/auth?code=abc&state=xyz" }).call("infiniteTrack('x')")).toBe(false)
    expect(page({ posthog: true, url: "https://acme.com/auth?error=access_denied" }).call("infiniteTrack('x')")).toBe(false)
    expect(page({ posthog: true, url: "https://acme.com/pricing?code=SPRING" }).call("infiniteTrack('x')")).toBe(true)
  })
})

/** A DOM-shaped anchor (`.href` is absolute, as the DOM reports it). */
function anchorSource(href: string, target?: string): string {
  return `({ tagName: 'A', href: new URL(${jsSource(href)}, location.href).href, getAttribute: function (n) { return n === 'target' ? ${jsSource(target ?? null)} : null } })`
}
const BUTTON = "({ tagName: 'BUTTON', getAttribute: function () { return null } })"

describe("infiniteTrackThenNavigate", () => {
  it("with no tags present, nothing throws and an anchor's own navigation proceeds (nothing is held)", async () => {
    const p = page()
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("/signup")}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/signup', 'cta_clicked')")
    expect(event.defaultPrevented).toBe(false) // the browser's own navigation proceeds at once
    expect(p.vm.assigned).toEqual([])
    // A programmatic call (no event) navigates now.
    p.call("infiniteTrackThenNavigate(null, '/signup', 'cta_clicked')")
    expect(p.vm.assigned).toEqual(["https://acme.com/signup"])
    await p.vm.advance(2000)
    expect(p.vm.assigned).toHaveLength(1)
  })

  // P1-1: a <button> CTA (a string target with a click) has no navigation of its own. Every case where
  // GA4 did not start must still take the visitor there, at once.
  it.each([
    ["no tags at all", {} as PageOptions],
    ["an ADOPTED gtag (no lane marker)", { ga4: "adopted", callback: "never" } as PageOptions],
    ["consent no (GPC is not enough; an explicit denial)", { ga4: "managed", callback: "never", localStorage: { infinite_analytics_consent: "denied" } } as PageOptions],
    ["required mode before a grant", { ga4: "managed", callback: "never", consentMode: "required" } as PageOptions]
  ])("a button click goes there at once when GA4 did not start: %s", async (_label, options) => {
    const p = page(options)
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${BUTTON}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/signup', 'cta_clicked')")
    expect(p.vm.assigned).toEqual(["https://acme.com/signup"])
    expect(event.defaultPrevented).toBe(true) // a submit button must not race the navigation
    await p.vm.advance(2000)
    expect(p.vm.assigned).toHaveLength(1)
  })

  it("a button click with a bad event name still navigates (nothing is sent)", () => {
    const p = page({ ga4: "managed", posthog: true })
    p.vm.window.__event = p.click()
    p.call("infiniteTrackThenNavigate(window.__event, '/signup', 'not a name')")
    expect(p.vm.assigned).toEqual(["https://acme.com/signup"])
    expect(p.gtagCalls).toEqual([])
    expect(p.posthogCalls).toEqual([])
  })

  it("negative: an anchor click with the SAME href is the browser's own navigation, so the helper does not navigate too", () => {
    const p = page({ ga4: "adopted" })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("https://acme.com/signup")}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/signup', 'cta_clicked')")
    expect(p.vm.assigned).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  it("an anchor pointing somewhere ELSE is not the browser's navigation: the helper goes to the destination", () => {
    const p = page()
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("/pricing")}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/signup', 'cta_clicked')")
    expect(event.defaultPrevented).toBe(true)
    expect(p.vm.assigned).toEqual(["https://acme.com/signup"])
  })

  it("a button click the site already prevented still navigates (the caller asked the helper to go)", () => {
    const p = page({ ga4: "adopted" })
    p.vm.window.__event = p.click({ defaultPrevented: true })
    p.call("infiniteTrackThenNavigate(window.__event, '/signup', 'cta_clicked')")
    expect(p.vm.assigned).toEqual(["https://acme.com/signup"])
  })

  it("holds a same-tab click until GA4 has the hit, and navigates exactly once", async () => {
    const p = page({ ga4: "managed", callback: "once", posthog: true })
    const event = p.click()
    p.vm.window.__event = event
    p.call("infiniteTrackThenNavigate(window.__event, { href: 'https://acme.com/download', getAttribute: function () { return null } }, 'download_clicked', { cta_location: 'hero' })")
    expect(event.defaultPrevented).toBe(true)
    expect(p.vm.assigned).toEqual(["https://acme.com/download"])
    const params = p.gtagCalls[0]![2] as Record<string, unknown>
    expect(params.send_to).toBe("G-TEST123")
    expect(params.event_timeout).toBe(1000)
    expect(params.cta_location).toBe("hero")
    expect(plain(p.posthogCalls)).toEqual([["capture", "download_clicked", { cta_location: "hero" }]])
    await p.vm.advance(1500) // the backstop fires, and cannot navigate a second time
    expect(p.vm.assigned).toHaveLength(1)
  })

  it("event_callback never fires → navigates exactly once, at 1000 ms", async () => {
    const p = page({ ga4: "managed", callback: "never" })
    p.vm.window.__event = p.click()
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    await p.vm.advance(999)
    expect(p.vm.assigned).toEqual([])
    await p.vm.advance(1)
    expect(p.vm.assigned).toEqual(["https://acme.com/download"])
    await p.vm.advance(5000)
    expect(p.vm.assigned).toHaveLength(1)
  })

  it("the callback fires twice → navigates once", async () => {
    const p = page({ ga4: "managed", callback: "twice" })
    p.vm.window.__event = p.click()
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    await p.vm.advance(2000)
    expect(p.vm.assigned).toEqual(["https://acme.com/download"])
  })

  it("preventDefault only when the GA4 LANE started: an adopted gtag with no marker holds nothing", async () => {
    const p = page({ ga4: "adopted", callback: "never" })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("/download")}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    expect(event.defaultPrevented).toBe(false)
    // The event is still sent, best effort, with no callback to wait on.
    expect(plain(p.gtagCalls)).toEqual([["event", "download_clicked", {}]])
    await p.vm.advance(2000)
    expect(p.vm.assigned).toEqual([])
  })

  it("R4-5 (live run 4, Codex F5): the site's OWN GA4 whose gtag.js loaded IS waited for (callback, then go), with no send_to", async () => {
    const p = page({ ga4: "adopted", callback: "once" })
    p.vm.window.google_tag_manager = { "G-QWERT67890": {} }
    p.call("infiniteTrackThenNavigate(null, '/account', 'signup')")
    const params = p.gtagCalls[0]![2] as Record<string, unknown>
    expect(p.gtagCalls[0]!.slice(0, 2)).toEqual(["event", "signup"])
    expect(typeof params.event_callback).toBe("function")
    expect(params.event_timeout).toBe(1000)
    expect(params).not.toHaveProperty("send_to")
    expect(p.vm.assigned).toEqual(["https://acme.com/account"])
    await p.vm.advance(2000)
    expect(p.vm.assigned).toEqual(["https://acme.com/account"])
  })

  it("R4-5: a loaded adopted GA4 that never calls back releases the navigation at 1 s, never later", async () => {
    const p = page({ ga4: "adopted", callback: "never" })
    p.vm.window.google_tag_manager = { "G-QWERT67890": {} }
    p.call("infiniteTrackThenNavigate(null, '/account', 'signup')")
    expect(p.vm.assigned).toEqual([])
    await p.vm.advance(999)
    expect(p.vm.assigned).toEqual([])
    await p.vm.advance(2)
    expect(p.vm.assigned).toEqual(["https://acme.com/account"])
  })

  it("negative (live run 4): with no lane marker and no loaded gtag.js, the conversion goes out unheld and the page leaves at once", async () => {
    const p = page({ ga4: "adopted", callback: "never" })
    p.call("infiniteTrackThenNavigate(null, '/account', 'signup')")
    expect(plain(p.gtagCalls)).toEqual([["event", "signup", {}]])
    expect(p.vm.assigned).toEqual(["https://acme.com/account"])
  })

  it("negative: keying the hold off `typeof gtag` (the old rule) would hold the adopted click for a full second", async () => {
    const p = page({ ga4: "adopted", callback: "never" })
    p.vm.window.__infiniteGa4Lane = { id: "G-ADOPTED" } // what the old heuristic effectively assumed
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("/download")}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    expect(event.defaultPrevented).toBe(true)
    await p.vm.advance(999)
    expect(p.vm.assigned).toEqual([])
  })

  it("leaves new-tab and modified ANCHOR clicks to the browser", () => {
    for (const overrides of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const p = page({ ga4: "managed", callback: "never" })
      const event = p.click(overrides)
      p.vm.window.__event = event
      p.call(`window.__event.currentTarget = ${anchorSource("/download")}`)
      p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
      expect(event.defaultPrevented).toBe(false)
      expect((p.gtagCalls[0]![2] as Record<string, unknown>).event_callback).toBeUndefined()
      expect(p.vm.assigned).toEqual([])
    }
    const p = page({ ga4: "managed", callback: "never" })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("https://acme.com/x", "_blank")}`)
    p.call(`infiniteTrackThenNavigate(window.__event, window.__event.currentTarget, 'cta')`)
    expect(event.defaultPrevented).toBe(false)
    expect(p.vm.opened).toEqual([])
  })

  it("negative: a modified click on a BUTTON is still the helper's navigation (a button has no new-tab gesture)", () => {
    const p = page({ ga4: "managed", callback: "never" })
    p.vm.window.__event = p.click({ metaKey: true })
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    expect((p.gtagCalls[0]![2] as Record<string, unknown>).event_callback).toBeTypeOf("function")
  })

  it("a delegated listener that passes the anchor the click landed in leaves that anchor to the browser", () => {
    const p = page()
    const event = p.click()
    p.vm.window.__event = event
    p.call("window.__span = { tagName: 'SPAN' }")
    p.call(`window.__anchor = ${anchorSource("/download")}; window.__anchor.contains = function (node) { return node === window.__span }`)
    p.call("window.__event.currentTarget = { nodeType: 9 }; window.__event.target = window.__span")
    p.call("infiniteTrackThenNavigate(window.__event, window.__anchor, 'download_clicked')")
    expect(event.defaultPrevented).toBe(false)
    expect(p.vm.assigned).toEqual([])
    // Negative: the same anchor, but the click landed outside it (a button elsewhere): the helper goes.
    const other = p.click()
    p.vm.window.__event = other
    p.call(`window.__event.currentTarget = { nodeType: 9 }; window.__event.target = ${BUTTON}`)
    p.call("infiniteTrackThenNavigate(window.__event, window.__anchor, 'download_clicked')")
    expect(p.vm.assigned).toEqual(["https://acme.com/download"])
  })

  it("a target=_blank destination the browser will not open itself opens in a new tab, at once", () => {
    const p = page({ ga4: "managed", callback: "never" })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${BUTTON}`)
    p.call(`infiniteTrackThenNavigate(window.__event, ${anchorSource("https://acme.com/x", "_blank")}, 'cta')`)
    expect(p.vm.opened).toEqual(["_blank https://acme.com/x"])
    expect(p.vm.assigned).toEqual([])
  })

  it("a denied consent hook captures nothing and never holds the click", async () => {
    const p = page({ ga4: "managed", posthog: true, callback: "never", localStorage: { infinite_analytics_consent: "denied" } })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${anchorSource("/download")}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    expect(event.defaultPrevented).toBe(false)
    expect(p.gtagCalls).toEqual([])
    expect(p.posthogCalls).toEqual([])
  })

  it("leaves an already-prevented ANCHOR click alone (a router took it), and refuses a javascript: destination", () => {
    const p = page({ ga4: "managed", callback: "once" })
    p.vm.window.__event = p.click({ defaultPrevented: true })
    p.call(`infiniteTrackThenNavigate(window.__event, ${anchorSource("/download")}, 'download_clicked')`)
    p.call("infiniteTrackThenNavigate(null, 'javascript:alert(1)', 'download_clicked')")
    p.vm.window.__event = p.click()
    p.call("infiniteTrackThenNavigate(window.__event, 'javascript:alert(1)', 'download_clicked')")
    expect(p.gtagCalls).toEqual([])
    expect(p.vm.assigned).toEqual([])
  })

  it("a gtag that throws after the click was held still navigates at once", () => {
    const p = page({ ga4: "managed" })
    p.vm.window.gtag = () => {
      throw new Error("broken gtag")
    }
    const event = p.click()
    p.vm.window.__event = event
    p.call("infiniteTrackThenNavigate(window.__event, '/download', 'download_clicked')")
    expect(event.defaultPrevented).toBe(true)
    expect(p.vm.assigned).toEqual(["https://acme.com/download"])
  })

  it("waits briefly for a browser-only Meta event before navigating when GA4 is not holding the click", async () => {
    const p = page({ posthog: true, ga4: false })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${BUTTON}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', { item_id: 'sku_1' })")
    expect(event.defaultPrevented).toBe(true)
    expect(p.vm.assigned).toEqual([])
    expect(plain(p.fbqCalls)).toEqual([
      ["track", "AddToCart", { item_id: "sku_1", content_ids: ["sku_1"], content_type: "product", contents: [{ id: "sku_1", quantity: 1 }] }]
    ])
    await p.vm.resourceLoaded("https://www.facebook.com/tr/?id=1234567890123456&ev=AddToCart")
    expect(p.vm.assigned).toEqual(["https://acme.com/cart"])
    await p.vm.advance(1000)
    expect(p.vm.assigned).toHaveLength(1)
  })

  it("when GA4 is also holding the click, it still waits for Meta's /tr before navigating", async () => {
    const p = page({ posthog: true, ga4: "managed", callback: "once" })
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${BUTTON}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', { item_id: 'sku_1', item_name: 'Trail Pack', price: 249, quantity: 1, value: 249, currency: 'USD' })")
    expect(event.defaultPrevented).toBe(true)
    expect(p.vm.assigned).toEqual([])
    expect(plain(p.fbqCalls[0]![2] as Record<string, unknown>)).toMatchObject({
      content_ids: ["sku_1"],
      contents: [{ id: "sku_1", quantity: 1, item_price: 249 }],
      value: 249,
      currency: "USD"
    })
    await p.vm.resourceLoaded("https://www.facebook.com/tr/?id=1234567890123456&ev=AddToCart")
    expect(p.vm.assigned).toEqual(["https://acme.com/cart"])
    await p.vm.advance(1000)
    expect(p.vm.assigned).toHaveLength(1)
  })
})

describe("store fixture E2E through the emitted helpers", () => {
  it("sends store product events to GA4/PostHog/Infinite and browser-only Meta once, waiting for AddToCart before leaving", async () => {
    const p = page({ posthog: true, ga4: "managed", callback: "once" })
    const infiniteCalls: Call[] = []
    p.vm.window.__infiniteRecordEvent = (...args: unknown[]) => {
      infiniteCalls.push(args)
      return true
    }

    p.call("infiniteTrack('view_content', { item_id: 'sku_2', item_name: 'Trail Pack', price: 249, quantity: 1, value: 249, currency: 'USD' })")
    const event = p.click()
    p.vm.window.__event = event
    p.call(`window.__event.currentTarget = ${BUTTON}`)
    p.call("infiniteTrackThenNavigate(window.__event, '/cart', 'add_to_cart', { item_id: 'sku_2', item_name: 'Trail Pack', price: 249, quantity: 1, value: 249, currency: 'USD' })")
    expect(p.vm.assigned).toEqual([])
    await p.vm.resourceLoaded("https://www.facebook.com/tr/?id=1234567890123456&ev=AddToCart")
    expect(p.vm.assigned).toEqual(["https://acme.com/cart"])
    p.call("infiniteTrack('begin_checkout', { item_id: 'sku_2', item_name: 'Trail Pack', price: 249, quantity: 1, value: 249, currency: 'USD' })")

    const posthogNames = p.posthogCalls.map((call) => call[1])
    const ga4Names = p.gtagCalls.map((call) => call[1])
    const metaNames = p.fbqCalls.map((call) => call[1])
    const infiniteNames = infiniteCalls.map((call) => call[0])
    expect(posthogNames).toEqual(["view_content", "add_to_cart", "begin_checkout"])
    expect(ga4Names).toEqual(["view_content", "add_to_cart", "begin_checkout"])
    expect(metaNames).toEqual(["ViewContent", "AddToCart"])
    expect(infiniteNames).toEqual(["view_content", "add_to_cart", "begin_checkout"])

    for (const call of p.gtagCalls) {
      expect(plain(call[2] as Record<string, unknown>)).toMatchObject({
        items: [{ item_id: "sku_2", item_name: "Trail Pack", price: 249, quantity: 1 }],
        value: 249,
        currency: "USD"
      })
    }
    for (const call of p.fbqCalls) {
      expect(plain(call[2] as Record<string, unknown>)).toMatchObject({
        content_ids: ["sku_2"],
        content_type: "product",
        contents: [{ id: "sku_2", quantity: 1, item_price: 249 }],
        value: 249,
        currency: "USD",
        content_name: "Trail Pack"
      })
      expect(plain(call[2] as Record<string, unknown>)).not.toHaveProperty("eventID")
    }
    for (const call of infiniteCalls) {
      expect(plain(call[1] as Record<string, unknown>)).toMatchObject({
        item_id: "sku_2",
        item_name: "Trail Pack",
        value: 249,
        currency: "USD"
      })
    }
  })
})

describe("the Meta side keeps DNT/GPC as a no (P2-4 changes only the GA4/PostHog helpers)", () => {
  it("negative: on a GPC browser infiniteTrack sends, the mirror and the campaign capture do not", async () => {
    const p = page({ posthog: true, gpc: true, url: "https://acme.com/?utm_source=newsletter" })
    expect(p.call("infiniteTrack('x')")).toBe(true)
    await p.vm.evaluate<Promise<void>>("infiniteMetaMirror('Lead', 'evt-gpc')")
    expect(p.fbqCalls).toEqual([])
    expect(p.vm.sessionValues.size).toBe(0)
    expect(plain(p.call("infiniteCampaign()"))).toMatchObject({ campaignProvenance: "none" })
  })
})

describe("infiniteIdentify / infiniteReset", () => {
  it("identifies with a stable id, PostHog only", () => {
    const p = page({ posthog: true, ga4: "managed" })
    for (const id of ["9f2a5d41-7c0e-4b2a-9a77-2c0d8e4f6a10", "10293847", "cus_ABC123"]) {
      p.vm.window.__id = id
      expect(p.call("infiniteIdentify(window.__id)")).toBe(true)
    }
    expect(plain(p.posthogCalls.map((call) => call.slice(0, 2)))).toEqual([
      ["identify", "9f2a5d41-7c0e-4b2a-9a77-2c0d8e4f6a10"],
      ["identify", "10293847"],
      ["identify", "cus_ABC123"]
    ])
    expect(p.gtagCalls).toEqual([])
    expect(p.fbqCalls).toEqual([])
  })

  it("refuses an email, a URL, whitespace, an empty or an over-long id", () => {
    const p = page({ posthog: true })
    for (const id of ["person@example.test", "https://acme.com/u/1", "a b", "", "x".repeat(129), "a=b"]) {
      p.vm.window.__id = id
      expect(p.call("infiniteIdentify(window.__id)")).toBe(false)
    }
    expect(p.posthogCalls).toEqual([])
  })

  it("follows consent, and never throws without PostHog", () => {
    expect(page({ posthog: true, localStorage: { infinite_analytics_consent: "denied" } }).call("infiniteIdentify('u1')")).toBe(false)
    const none = page()
    expect(none.call("infiniteIdentify('u1')")).toBe(false)
    expect(none.call("infiniteReset()")).toBe(false)
  })

  it("reset forgets the person, consent or not", () => {
    const p = page({ posthog: true, localStorage: { infinite_analytics_consent: "denied" } })
    expect(p.call("infiniteReset()")).toBe(true)
    expect(plain(p.posthogCalls)).toEqual([["reset"]])
  })
})
