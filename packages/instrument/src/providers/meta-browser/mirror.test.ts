// The Meta mirror, EXECUTED on a virtual clock.
//
// Ported from infinite-site @ 9f65b47:
//   - `.github/scripts/test-get-started-page.mjs` L1258-1351: `metaEventId` null → no fbq (L1270-1277);
//     absent → none (L1285-1298); the server's id used verbatim (L1310-1318); null on the second path →
//     none (L1329-1333); "" → none (L1344-1351).
//   - `.github/scripts/test-growth-lead-form.mjs`: the FakePerformanceObserver (L102-138), the order
//     ["fbq", "navigate"] with the eventID unchanged (L304-305), only THIS request releases the wait,
//     the budget releases an ad-blocked page, and no PerformanceObserver still means one event within the
//     budget (around L335).
// Plus: an identity hash that settles after 50 ms keeps the order, a POST /tr releases at 400 ms and
// never earlier, Purchase is refused, once per id, two ids mirror twice.
import { describe, expect, it } from "vitest"

import { createBrowserVm, plain, type BrowserVmOptions } from "../../../test/site-code/browser-vm.js"

import { buildMetaMirrorScript, META_MIRROR_EVENTS } from "./mirror.js"

const EVENT_ID = "9f2a5d41-7c0e-4b2a-9a77-2c0d8e4f6a10"
const lead = (eventId = EVENT_ID, extra = "") =>
  `https://www.facebook.com/tr/?id=1234567890123456&ev=Lead&dl=https%3A%2F%2Facme.com%2F&eid=${eventId}${extra}`

interface MirrorPage {
  vm: ReturnType<typeof createBrowserVm>
  timeline: unknown[][]
  mirror(name: string, id: unknown, options?: string): void
  resolved(): number
}

/** The pixel the managed helper bakes in (B16: the mirror fires on it only). */
const PIXEL = "1234567890123456"

function mirrorPage(options: BrowserVmOptions & { pixel?: boolean; bakedPixel?: string | null; consentMode?: "required" | "not_required"; matchDelayMs?: number | "never" } = {}): MirrorPage {
  const vm = createBrowserVm(options)
  const timeline: unknown[][] = []
  if (options.pixel !== false) vm.window.fbq = (...args: unknown[]) => void timeline.push(["fbq", ...args])
  if (options.matchDelayMs !== undefined) {
    vm.window.infiniteMetaAdvancedMatch = () => {
      timeline.push(["match"])
      if (options.matchDelayMs === "never") return new Promise(() => {})
      return new Promise((resolve) =>
        (vm.window.setTimeout as (cb: () => void, ms: number) => void)(() => resolve(true), options.matchDelayMs as number)
      )
    }
  }
  vm.window.__navigate = () => void timeline.push(["navigate"])
  vm.window.__resolved = 0
  vm.runScript(buildMetaMirrorScript({ gate: { kind: "infinite-consent", mode: options.consentMode ?? "not_required" }, pixelId: options.bakedPixel === undefined ? PIXEL : options.bakedPixel }))
  expect(vm.scriptErrors).toEqual([])
  return {
    vm,
    timeline,
    mirror(name, id, extra = "undefined") {
      vm.window.__id = id
      vm.evaluate(
        `infiniteMetaMirror(${JSON.stringify(name)}, window.__id, ${extra}).then(function () { window.__resolved += 1; window.__navigate(); }, function () { window.__rejected = true; })`
      )
    },
    resolved: () => vm.window.__resolved as number
  }
}

const tracks = (page: MirrorPage) => page.timeline.filter((entry) => entry[0] === "fbq")

describe("infiniteMetaMirror: the server's instruction or nothing", () => {
  it.each([
    ["null", null],
    ["absent", undefined],
    ["empty string", ""],
    ["a number", 42]
  ])("metaEventId %s → no fbq, resolved at once", async (_label, id) => {
    const page = mirrorPage()
    page.mirror("CompleteRegistration", id)
    await page.vm.settle()
    expect(tracks(page)).toEqual([])
    expect(page.resolved()).toBe(1)
  })

  it("uses the server's id verbatim, with empty custom data", async () => {
    const page = mirrorPage()
    page.mirror("CompleteRegistration", "Server-ID_Case.Kept", "{ wait: 'none' }")
    await page.vm.settle()
    expect(plain(tracks(page))).toEqual([["fbq", "trackSingle", PIXEL, "CompleteRegistration", {}, { eventID: "Server-ID_Case.Kept" }]])
  })

  it("§3z.10 (B16): fires on the BAKED pixel only (trackSingle); with no baked pixel it fires nothing", async () => {
    const page = mirrorPage()
    page.mirror("Lead", "id-baked", "{ wait: 'none' }")
    await page.vm.settle()
    expect(plain(tracks(page))).toEqual([["fbq", "trackSingle", PIXEL, "Lead", {}, { eventID: "id-baked" }]])
    // negative: no baked pixel (or an invalid one) → nothing, resolved at once
    for (const baked of [null, "123"]) {
      const none = mirrorPage({ bakedPixel: baked })
      none.mirror("Lead", "id-none")
      await none.vm.settle()
      expect(tracks(none)).toEqual([])
      expect(none.resolved()).toBe(1)
    }
  })

  it("refuses Purchase (webhook-only) and any event outside the allowlist", async () => {
    const page = mirrorPage()
    for (const name of ["Purchase", "PageView", "AddToCart", "lead"]) page.mirror(name, `id-${name}`)
    await page.vm.settle()
    expect(tracks(page)).toEqual([])
    expect(page.resolved()).toBe(4)
    expect(META_MIRROR_EVENTS).not.toContain("Purchase")
  })

  it("mirrors each allowlisted event (StartTrial and Subscribe included, decision 16)", async () => {
    const page = mirrorPage()
    for (const name of META_MIRROR_EVENTS) page.mirror(name, `id-${name}`, "{ wait: 'none' }")
    await page.vm.settle()
    expect(tracks(page).map((entry) => entry[3])).toEqual([...META_MIRROR_EVENTS])
  })

  it("once per id; two ids → two mirrors", async () => {
    const page = mirrorPage()
    page.mirror("Lead", "id-1", "{ wait: 'none' }")
    page.mirror("Lead", "id-1", "{ wait: 'none' }")
    page.mirror("Lead", "id-2", "{ wait: 'none' }")
    await page.vm.settle()
    expect(plain(tracks(page).map((entry) => (entry[5] as { eventID: string }).eventID))).toEqual(["id-1", "id-2"])
    expect(page.resolved()).toBe(3)
  })

  it("no fbq (pixel guarded, blocked or unconfigured) → nothing to wait for", async () => {
    const page = mirrorPage({ pixel: false })
    page.mirror("Lead", EVENT_ID)
    await page.vm.settle()
    expect(page.resolved()).toBe(1)
    expect(page.vm.pendingTimers()).toEqual([])
  })

  it("follows consent at call time, and the site's own gate", async () => {
    const denied = mirrorPage({ localStorage: { infinite_analytics_consent: "denied" } })
    denied.mirror("Lead", EVENT_ID)
    const required = mirrorPage({ consentMode: "required" })
    required.mirror("Lead", EVENT_ID)
    const gated = mirrorPage()
    gated.mirror("Lead", EVENT_ID, "{ gate: function () { return false } }")
    for (const page of [denied, required, gated]) {
      await page.vm.settle()
      expect(tracks(page)).toEqual([])
      expect(page.resolved()).toBe(1)
    }
  })
})

describe("infiniteMetaMirror: the page waits for THIS request, never longer than 400 ms", () => {
  it("fires first, navigates the moment this event's /tr request completes", async () => {
    const page = mirrorPage()
    page.mirror("Lead", EVENT_ID)
    await page.vm.settle()
    expect(tracks(page)).toHaveLength(1)
    expect(page.resolved()).toBe(0)
    expect(page.vm.pendingTimers()).toEqual([400])
    await page.vm.resourceLoaded(lead())
    expect(page.resolved()).toBe(1)
    expect(page.timeline.map((entry) => entry[0])).toEqual(["fbq", "navigate"])
    expect(plain(page.timeline[0])).toEqual(["fbq", "trackSingle", PIXEL, "Lead", {}, { eventID: EVENT_ID }])
    expect(page.vm.pendingTimers()).toEqual([])
    expect(page.vm.observing()).toBe(false)
    await page.vm.advance(1000)
    expect(page.resolved()).toBe(1)
  })

  it("only THIS request releases it: not a PageView, not another id, not a look-alike host", async () => {
    const page = mirrorPage()
    page.mirror("Lead", EVENT_ID)
    await page.vm.resourceLoaded(lead().replace("ev=Lead", "ev=PageView"))
    await page.vm.resourceLoaded(lead("someone-else"))
    await page.vm.resourceLoaded(lead().replace("www.facebook.com", "www.facebook.com.evil.example"))
    await page.vm.resourceLoaded("https://acme.com/tr?ev=Lead&eid=" + EVENT_ID)
    expect(page.resolved()).toBe(0)
    await page.vm.advance(400)
    expect(page.resolved()).toBe(1)
  })

  it("a POST /tr (long landing URL, no query) releases at 400 ms and never earlier", async () => {
    const page = mirrorPage()
    page.mirror("Lead", EVENT_ID)
    await page.vm.resourceLoaded("https://www.facebook.com/tr/")
    await page.vm.advance(399)
    expect(page.resolved()).toBe(0)
    await page.vm.advance(1)
    expect(page.resolved()).toBe(1)
    expect(tracks(page)).toHaveLength(1)
  })

  it("an ad blocker (no request ever) is released by the budget; a late report changes nothing", async () => {
    const page = mirrorPage()
    page.mirror("Lead", EVENT_ID)
    await page.vm.advance(400)
    expect(page.resolved()).toBe(1)
    await page.vm.resourceLoaded(lead())
    expect(page.resolved()).toBe(1)
    expect(tracks(page)).toHaveLength(1)
  })

  it("an old browser without PerformanceObserver: still one event, still bounded by 400 ms", async () => {
    const page = mirrorPage({ performanceObserver: false })
    page.mirror("Lead", EVENT_ID)
    await page.vm.settle()
    expect(tracks(page)).toHaveLength(1)
    expect(page.vm.pendingTimers()).toEqual([400])
    await page.vm.advance(400)
    expect(page.resolved()).toBe(1)
  })

  it("a shorter budget is honoured; a longer one is capped at 400 ms", async () => {
    const short = mirrorPage()
    short.mirror("Lead", EVENT_ID, "{ budgetMs: 100 }")
    await short.vm.advance(100)
    expect(short.resolved()).toBe(1)
    const long = mirrorPage()
    long.mirror("Lead", EVENT_ID, "{ budgetMs: 5000 }")
    await long.vm.advance(400)
    expect(long.resolved()).toBe(1)
  })

  it("never rejects: a pixel that throws still releases the page at once", async () => {
    const page = mirrorPage({ pixel: false })
    page.vm.window.fbq = () => {
      throw new Error("blocked")
    }
    page.mirror("Lead", EVENT_ID)
    await page.vm.settle()
    expect(page.resolved()).toBe(1)
    expect(page.vm.window.__rejected).toBeUndefined()
  })
})

describe("infiniteMetaMirror: identity through the Advanced Matching accessor", () => {
  it("an identity hash that settles after 50 ms keeps the order: match, fbq, navigate", async () => {
    const page = mirrorPage({ matchDelayMs: 50 })
    page.mirror("CompleteRegistration", EVENT_ID, "{ identity: { email: 'a@b.co' }, wait: 'none' }")
    await page.vm.advance(49)
    expect(page.timeline.map((entry) => entry[0])).toEqual(["match"])
    await page.vm.advance(1)
    expect(page.timeline.map((entry) => entry[0])).toEqual(["match", "fbq", "navigate"])
  })

  it("an identity that never settles cannot hold the page: the budget fires the event and releases", async () => {
    const page = mirrorPage({ matchDelayMs: "never" })
    page.mirror("CompleteRegistration", EVENT_ID, "{ identity: { email: 'a@b.co' } }")
    await page.vm.advance(399)
    expect(tracks(page)).toEqual([])
    await page.vm.advance(1)
    expect(page.timeline.map((entry) => entry[0])).toEqual(["match", "fbq", "navigate"])
  })

  it("without the accessor the identity is ignored and the event fires at once", async () => {
    const page = mirrorPage()
    page.mirror("CompleteRegistration", EVENT_ID, "{ identity: { email: 'a@b.co' }, wait: 'none' }")
    await page.vm.settle()
    expect(page.timeline.map((entry) => entry[0])).toEqual(["fbq", "navigate"])
  })
})

it("emits no backtick, no ${ and no </", () => {
  expect(buildMetaMirrorScript({ gate: { kind: "infinite-consent", mode: "required" } })).not.toMatch(/`|\$\{|<\//)
})
