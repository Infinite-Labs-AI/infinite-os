import { runInNewContext } from "node:vm"

import { describe, expect, it } from "vitest"

import { renderInfiniteBrowserTag } from "./infinite-browser.js"

/** Mirrors InfiniteHandoffContext — declared locally so the pins prove the SHAPE, not an import. */
interface HandoffContextShape {
  siteSourceKey: string
  anonymousId: string
  sessionId: string
  url: string
}

type HarnessWindow = Record<string, unknown> & {
  __infiniteHandoffContext?: () => HandoffContextShape | null
}

interface HarnessOptions {
  href?: string
  referrer?: string
  dnt?: string
  gpc?: boolean
  consent?: string
  consentMode?: "required" | "not_required"
  siteSourceKey?: string
  /** Pretend the page is driven by WebDriver (Playwright/Puppeteer/Lighthouse). */
  webdriver?: boolean
  failedFetches?: number
  productionHosts?: string[]
  consentWriteFails?: boolean
  downloadDestinationPath?: string
}

function createStorage(initial: Record<string, string> = {}, failWrites = false) {
  const values = new Map(Object.entries(initial))
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      if (failWrites) throw new Error("storage write failed")
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    }
  }
}

function executeTag(options: HarnessOptions = {}) {
  const href = options.href ?? "https://example.com/privacy?secret=yes#section"
  let currentUrl = new URL(href)
  const requests: Array<{
    body: Record<string, unknown>
    rawBody: string
    headers: Record<string, string>
  }> = []
  // 0.6.0: provider globals are INSTALLED in the harness window so the pins can prove the runtime
  // never touches them (no capture, no set_config / opt_in / opt_out, no gtag, no consent bridge).
  const posthogEvents: Array<{
    name: string
    properties: Record<string, unknown>
  }> = []
  const posthogPrivacyCalls: Array<{ method: string; value?: unknown }> = []
  const ga4Events: Array<unknown[]> = []
  const ga4LoaderCalls: string[] = []
  const documentListeners = new Map<string, (event: unknown) => void>()
  const windowListeners = new Map<string, (event: unknown) => void>()
  const localStorage = createStorage(
    options.consent === undefined ? {} : { infinite_analytics_consent: options.consent },
    options.consentWriteFails
  )
  const sessionStorage = createStorage()

  const location = {
    get href() {
      return currentUrl.href
    },
    get hostname() {
      return currentUrl.hostname
    },
    get origin() {
      return currentUrl.origin
    },
    get pathname() {
      return currentUrl.pathname
    }
  }

  const windowObject: HarnessWindow = {
    location,
    localStorage,
    sessionStorage,
    addEventListener(type: string, listener: (event: unknown) => void) {
      windowListeners.set(type, listener)
    }
  }
  windowObject.posthog = {
    capture(name: string, properties: Record<string, unknown>) {
      posthogEvents.push({ name, properties })
    },
    opt_in_capturing() {
      posthogPrivacyCalls.push({ method: "opt_in_capturing" })
    },
    opt_out_capturing() {
      posthogPrivacyCalls.push({ method: "opt_out_capturing" })
    },
    set_config(value: unknown) {
      posthogPrivacyCalls.push({ method: "set_config", value })
    }
  }
  windowObject.gtag = (...args: unknown[]) => {
    ga4Events.push(args)
  }
  windowObject.__infiniteGa4Consent = {
    grant() {
      ga4LoaderCalls.push("grant")
    },
    deny() {
      ga4LoaderCalls.push("deny")
    }
  }
  let failedFetches = options.failedFetches ?? 0

  const history = {
    pushState(_state: unknown, _title: string, next?: string | URL | null) {
      if (next) currentUrl = new URL(String(next), currentUrl)
    },
    replaceState(_state: unknown, _title: string, next?: string | URL | null) {
      if (next) currentUrl = new URL(String(next), currentUrl)
    }
  }

  const tag = renderInfiniteBrowserTag({
    ...(options.siteSourceKey ? { siteSourceKey: options.siteSourceKey } : {}),
    collectPath: "/infinite/events/collect",
    respectDnt: true,
    consent:
      options.consentMode === "not_required"
        ? { mode: "not_required" }
        : { mode: "required", storageKey: "infinite_analytics_consent" },
    productionHosts: options.productionHosts ?? ["example.com"],
    ...(options.downloadDestinationPath
      ? { downloadDestinationPath: options.downloadDestinationPath }
      : {})
  })
  const source = tag.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "")

  const context = {
    window: windowObject,
    document: {
      referrer: options.referrer ?? "https://referrer.example/start?private=yes",
      addEventListener(type: string, listener: (event: unknown) => void) {
        documentListeners.set(type, listener)
      }
    },
    location,
    history,
    localStorage,
    sessionStorage,
    navigator: {
      doNotTrack: options.dnt ?? "0",
      globalPrivacyControl: options.gpc ?? false,
      ...(options.webdriver === undefined ? {} : { webdriver: options.webdriver }),
      sendBeacon() {
        return false
      }
    },
    crypto: {
      randomUUID: (() => {
        let id = 0
        return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`
      })()
    },
    fetch: async (_path: string, init: { body?: string; headers?: Record<string, string> }) => {
      const rawBody = init.body ?? "{}"
      requests.push({
        body: JSON.parse(rawBody) as Record<string, unknown>,
        rawBody,
        headers: init.headers ?? {}
      })
      if (failedFetches > 0) {
        failedFetches -= 1
        return { ok: false }
      }
      return { ok: true }
    },
    setTimeout(callback: () => void) {
      callback()
      return 1
    },
    clearTimeout() {},
    URL,
    Date,
    JSON,
    Math,
    console
  }
  Object.assign(windowObject, context)
  runInNewContext(source, context)

  return {
    tag,
    /** The runtime's window — where the narrow handoff accessor is (or is not) installed. */
    window: windowObject,
    requests,
    posthogEvents,
    posthogPrivacyCalls,
    ga4Events,
    ga4LoaderCalls,
    history,
    setUrl(next: string) {
      currentUrl = new URL(next, currentUrl)
    },
    click(target: unknown) {
      documentListeners.get("click")?.({ target })
    },
    submit(target: unknown) {
      documentListeners.get("submit")?.({ target })
    },
    popstate() {
      windowListeners.get("popstate")?.({})
    },
    setConsent(granted: boolean) {
      // A real consent UI produces a gesture right before dispatching (see the runtime's
      // gesture gate) — simulate the pointerdown a banner click would generate.
      documentListeners.get("pointerdown")?.({})
      windowListeners.get("infinite:analytics-consent-change")?.({
        detail: { granted }
      })
    },
    setConsentWithoutGesture(granted: boolean) {
      windowListeners.get("infinite:analytics-consent-change")?.({
        detail: { granted }
      })
    },
    /** The runtime's OWN identity keys — proof the handoff accessor mints no NEW identity. */
    storedIds() {
      return {
        anonymousId: localStorage.getItem("infinite_analytics_visitor"),
        sessionId: sessionStorage.getItem("infinite_analytics_session")
      }
    },
    /** TRUE when the runtime touched any provider global — must always be false since 0.6.0. */
    touchedProviders(): boolean {
      return posthogEvents.length > 0 || posthogPrivacyCalls.length > 0 || ga4Events.length > 0 || ga4LoaderCalls.length > 0
    }
  }
}

function managedTarget(input: {
  href?: string
  ctaId?: string
  ctaLocation?: string
  downloadLocation?: string
  downloadAnalyticsLocation?: string
  text?: string
}) {
  const anchor = input.href
    ? {
        href: input.href,
        textContent: input.text ?? "private download text",
        getAttribute(name: string) {
          if (name === "href") return input.href ?? null
          if (name === "data-download-location") return input.downloadLocation ?? null
          if (name === "data-analytics-cta-location") {
            return input.downloadAnalyticsLocation ?? null
          }
          return null
        }
      }
    : null
  const cta = input.ctaId
    ? {
        textContent: input.text ?? "private visible text",
        getAttribute(name: string) {
          if (name === "data-analytics-cta-id") return input.ctaId ?? null
          if (name === "data-analytics-cta-location") return input.ctaLocation ?? null
          return null
        },
        closest(selector: string) {
          return selector === "a[href]" ? anchor : null
        }
      }
    : null
  return {
    closest(selector: string) {
      if (selector === "[data-analytics-cta-id]") return cta
      if (selector === "a[href]") return anchor
      return null
    }
  }
}

/** A click target on/inside an element marked data-conversion="signup" — optionally an anchor,
 *  optionally ALSO a generic CTA (for the precedence test). Mirrors managedTarget's fake shape. */
function signupTarget(input: {
  href?: string
  ctaId?: string
  ctaLocation?: string
  alsoGenericCta?: boolean
}) {
  const anchor = input.href
    ? {
        href: input.href,
        getAttribute(name: string) {
          return name === "href" ? (input.href ?? null) : null
        }
      }
    : null
  const signup = {
    getAttribute(name: string) {
      if (name === "data-conversion") return "signup"
      if (name === "data-analytics-cta-id") return input.ctaId ?? null
      if (name === "data-analytics-cta-location") return input.ctaLocation ?? null
      return null
    },
    closest(selector: string) {
      return selector === "a[href]" ? anchor : null
    }
  }
  const genericCta = input.alsoGenericCta
    ? {
        getAttribute(name: string) {
          if (name === "data-analytics-cta-id") return input.ctaId ?? "generic_id"
          if (name === "data-analytics-cta-location") return input.ctaLocation ?? "generic_loc"
          return null
        },
        closest(selector: string) {
          return selector === "a[href]" ? anchor : null
        }
      }
    : null
  return {
    closest(selector: string) {
      if (selector === '[data-conversion="signup"]') return signup
      if (selector === "[data-analytics-cta-id]") return genericCta
      if (selector === "a[href]") return anchor
      return null
    }
  }
}

/** A submit target inside form[data-conversion="signup"]. */
function signupFormTarget(input: { ctaId?: string; ctaLocation?: string; marked?: boolean }) {
  const form = input.marked === false
    ? null
    : {
        getAttribute(name: string) {
          if (name === "data-conversion") return "signup"
          if (name === "data-analytics-cta-id") return input.ctaId ?? null
          if (name === "data-analytics-cta-location") return input.ctaLocation ?? null
          return null
        }
      }
  return {
    closest(selector: string) {
      return selector === 'form[data-conversion="signup"]' ? form : null
    }
  }
}

function normalizeCloudPath(value: string): string {
  const pathname = new URL(value, "https://analytics.invalid").pathname.replace(/\/{2,}/g, "/")
  const stripped = pathname === "/" ? "/" : pathname.replace(/\/+$/, "") || "/"
  if (stripped === "/" || stripped === "/download" || stripped === "/LICENSE") return stripped
  const finalSegment = stripped.slice(stripped.lastIndexOf("/") + 1)
  return finalSegment.includes(".") ? stripped : `${stripped}/`
}

function parseLikeCloud(origin: string, payload: Record<string, unknown>) {
  if (typeof payload.url !== "string") throw new Error("cloud requires url")
  const originHost = new URL(origin).hostname.toLowerCase().replace(/\.$/, "")
  const urlHost = new URL(payload.url).hostname.toLowerCase().replace(/\.$/, "")
  if (urlHost !== originHost) throw new Error("cloud rejects url/origin host mismatch")
  let referrerHost: string | null = null
  if (payload.referrer) {
    const referrer = String(payload.referrer)
    referrerHost = new URL(referrer.includes("://") ? referrer : `https://${referrer}`).hostname
      .toLowerCase()
      .replace(/\.$/, "")
  }
  return { path: normalizeCloudPath(payload.url), referrerHost }
}

describe("renderInfiniteBrowserTag", () => {
  it("embeds one self-contained same-origin runtime with no external Infinite SDK route", () => {
    const tag = renderInfiniteBrowserTag({
      siteSourceKey: "site_public_123",
      collectPath: "/infinite/events/collect",
      respectDnt: true,
      consent: { mode: "not_required" },
      productionHosts: ["example.com"]
    })

    expect(tag).toContain("/infinite/events/collect")
    expect(tag).not.toContain("app.ultima.inc")
    expect(tag).not.toMatch(/\/tracking\/|\/sdk\//)
    expect(tag).not.toContain("workspace_id")
    expect(tag).not.toContain("environment")
    expect(tag).not.toContain("authority")
    // 0.6.0: the runtime carries NO provider coupling — no mirror names, no gtag, no posthog,
    // no consent bridge, no provider-ready polling.
    for (const gone of ["mirrors", "posthog", "gtag", "__infiniteGa4Consent", "$pageview", '"page_view"', "app_download_clicked", "set_config", "opt_in_capturing", "opt_out_capturing", "startWhenReady", "mirrorsReady"]) {
      expect(tag, gone).not.toContain(gone)
    }
  })

  it("rejects an absolute, legacy, or protocol-relative collection route", () => {
    const base = {
      siteSourceKey: "site_public_123",
      respectDnt: true,
      consent: { mode: "not_required" } as const,
      productionHosts: ["example.com"]
    }
    for (const collectPath of [
      "https://api.example/events",
      "//api.example/events",
      "/tracking/events",
      "/sdk/events",
      "/events`);alert(1)//"
    ]) {
      expect(() => renderInfiniteBrowserTag({ ...base, collectPath })).toThrow(
        /same-origin collectPath/
      )
    }
  })

  it("fires one normalized initial page view stamped nav:\"navigate\" — to Infinite ONLY, never into a provider", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    expect(runtime.requests).toHaveLength(1)
    expect(runtime.requests[0]?.body).toMatchObject({
      eventName: "site_page_view",
      url: "https://example.com/privacy/",
      referrer: "referrer.example",
      siteSourceKey: "site_public_123",
      properties: { nav: "navigate" }
    })
    expect(Object.keys(runtime.requests[0]!.body).sort()).toEqual(
      [
        "anonymousId",
        "eventId",
        "eventName",
        "occurredAt",
        "properties",
        "referrer",
        "sessionId",
        "siteSourceKey",
        "url"
      ].sort()
    )
    expect(parseLikeCloud("https://example.com", runtime.requests[0]!.body)).toEqual({
      path: "/privacy/",
      referrerHost: "referrer.example"
    })
    expect(JSON.stringify(runtime.requests[0]?.body)).not.toContain("secret=yes")
    expect(JSON.stringify(runtime.requests[0]?.body)).not.toContain("/start")
    // Mirror mode is gone: PostHog and GA4 globals were present on the window and untouched.
    expect(runtime.touchedProviders()).toBe(false)
    expect(runtime.posthogEvents).toEqual([])
    expect(runtime.ga4Events).toEqual([])
    expect(runtime.posthogPrivacyCalls).toEqual([])
    expect(runtime.ga4LoaderCalls).toEqual([])
  })

  it("stays dormant without a source key — and still never touches a provider", () => {
    const runtime = executeTag({ consent: "granted" })

    expect(runtime.requests).toEqual([])
    expect(runtime.touchedProviders()).toBe(false)
  })

  it("emits NOTHING when navigator.webdriver is true (automation-driven browsers are not visitors)", () => {
    const driven = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      webdriver: true
    })
    expect(driven.requests).toEqual([])
    // Nothing was bound either: a later route change or click stays silent.
    driven.history.pushState({}, "", "/tools")
    driven.click(managedTarget({ href: "https://example.com/download" }))
    expect(driven.requests).toEqual([])

    // `webdriver: false` (a real browser says so explicitly) and an absent flag both emit.
    const real = executeTag({ siteSourceKey: "site_public_123", consent: "granted", webdriver: false })
    expect(real.requests).toHaveLength(1)
  })

  it("stamps nav:\"navigate\" on the initial view and nav:\"history\" on History-API route changes (bounded enum), keeping the path-change dedupe", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.history.pushState({}, "", "/tools?private=yes")
    runtime.history.replaceState({}, "", "/pricing#plans")
    runtime.history.replaceState({}, "", "/pricing") // same canonical path → deduped
    runtime.setUrl("/privacy")
    runtime.popstate()

    expect(
      runtime.requests.map((request) => [request.body.url, (request.body.properties as { nav: string }).nav])
    ).toEqual([
      ["https://example.com/privacy/", "navigate"],
      ["https://example.com/tools/", "history"],
      ["https://example.com/pricing/", "history"],
      ["https://example.com/privacy/", "history"]
    ])
    const navValues = new Set(
      runtime.requests.map((request) => (request.body.properties as { nav: string }).nav)
    )
    expect([...navValues].every((value) => value === "navigate" || value === "history")).toBe(true)
    // Page views carry ONLY nav — no cta markers, no destination.
    for (const request of runtime.requests) {
      expect(Object.keys(request.body.properties as Record<string, unknown>)).toEqual(["nav"])
    }
  })

  it("a consent grant after the load emits the current page as the INITIAL view (nav:\"navigate\"); a revocation then a re-grant starts over", () => {
    const runtime = executeTag({ siteSourceKey: "site_public_123", consent: "denied" })
    expect(runtime.requests).toEqual([])
    runtime.setConsent(true)
    expect(runtime.requests.map((r) => (r.body.properties as { nav: string }).nav)).toEqual(["navigate"])
    runtime.history.pushState({}, "", "/tools")
    expect(runtime.requests.map((r) => (r.body.properties as { nav: string }).nav)).toEqual(["navigate", "history"])
    runtime.setConsent(false)
    runtime.setConsent(true)
    expect(runtime.requests.map((r) => (r.body.properties as { nav: string }).nav)).toEqual(["navigate", "history", "navigate"])
  })

  it("omits an empty referrer and reduces a populated referrer to the cloud-stored host", () => {
    const empty = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      referrer: ""
    })
    expect(empty.requests[0]?.body).not.toHaveProperty("referrer")

    const populated = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      referrer: "https://Referrer.Example.:8443/private/path?secret=yes#fragment"
    })
    expect(populated.requests[0]?.body.referrer).toBe("referrer.example")
    expect(JSON.stringify(populated.requests[0]?.body)).not.toMatch(
      /private\/path|secret=yes|fragment/
    )
  })

  it("binds immediately — the initial view is sent synchronously, waiting on no provider global", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.tag).not.toContain("setTimeout(startWhenReady")
  })

  it("retries a failed keepalive POST with the exact same event id and serialized body", async () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      failedFetches: 1
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(runtime.requests).toHaveLength(2)
    expect(runtime.requests[1]!.rawBody).toBe(runtime.requests[0]!.rawBody)
    expect(runtime.requests[1]!.body.eventId).toBe(runtime.requests[0]!.body.eventId)
  })

  it("tracks SPA routes once and never repeats the initial path", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.history.pushState({}, "", "/tools?private=yes")
    runtime.history.replaceState({}, "", "/pricing#plans")
    runtime.setUrl("/privacy")
    runtime.popstate()

    expect(runtime.requests.map((request) => request.body.url)).toEqual([
      "https://example.com/privacy/",
      "https://example.com/tools/",
      "https://example.com/pricing/",
      "https://example.com/privacy/"
    ])
  })

  it("tracks downloads and managed CTAs with structural properties only", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(managedTarget({ href: "https://example.com/download?campaign=private" }))
    runtime.click(
      managedTarget({
        href: "https://example.com/pricing?email=private",
        ctaId: "pricing_primary",
        ctaLocation: "hero",
        text: "Do not collect this text"
      })
    )

    expect(runtime.requests.slice(1).map((request) => request.body)).toEqual([
      expect.objectContaining({
        eventName: "app_download_click",
        url: "https://example.com/privacy/",
        referrer: "referrer.example",
        properties: { cta_id: "auto_download", destination_path: "/download" }
      }),
      expect.objectContaining({
        eventName: "site_click",
        url: "https://example.com/privacy/",
        referrer: "referrer.example",
        properties: {
          cta_id: "pricing_primary",
          cta_location: "hero",
          destination_path: "/pricing/"
        }
      })
    ])
    expect(runtime.requests.every((request) => !("path" in request.body))).toBe(true)
    const keysWithProperties = [
      "anonymousId",
      "eventId",
      "eventName",
      "occurredAt",
      "properties",
      "referrer",
      "sessionId",
      "siteSourceKey",
      "url"
    ].sort()
    expect(runtime.requests.slice(1).map((request) => Object.keys(request.body).sort())).toEqual([
      keysWithProperties,
      keysWithProperties
    ])
    expect(
      runtime.requests.map((request) => parseLikeCloud("https://example.com", request.body))
    ).toEqual([
      { path: "/privacy/", referrerHost: "referrer.example" },
      { path: "/privacy/", referrerHost: "referrer.example" },
      { path: "/privacy/", referrerHost: "referrer.example" }
    ])
    expect(JSON.stringify(runtime.requests)).not.toMatch(/campaign=|email=|Do not collect/)
    // Nothing forwarded into a provider — ever.
    expect(runtime.touchedProviders()).toBe(false)
  })

  it("autocaptures same-origin link clicks without manual CTA markers", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(
      managedTarget({
        href: "https://example.com/pricing?email=private#plans",
        text: "Do not collect pricing text"
      })
    )

    const clicks = runtime.requests.filter((request) => request.body.eventName === "site_click")
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.body.properties).toEqual({
      cta_id: "auto_pricing",
      cta_location: "page",
      destination_path: "/pricing/"
    })
    expect(JSON.stringify(clicks[0]?.body)).not.toMatch(/email=|plans|Do not collect/)
    expect(runtime.touchedProviders()).toBe(false)
  })

  it("autocaptures external commerce links without leaking the external URL", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(
      managedTarget({
        href: "https://buy.stripe.com/test_checkout?prefilled_email=private@example.com",
        text: "Buy now with private copy"
      })
    )

    const clicks = runtime.requests.filter((request) => request.body.eventName === "site_click")
    expect(clicks).toHaveLength(1)
    expect(clicks[0]?.body.properties).toEqual({
      cta_id: "external_stripe",
      cta_location: "page"
    })
    expect(JSON.stringify(clicks[0]?.body)).not.toMatch(/buy\.stripe|prefilled_email|private copy/)
    expect(runtime.touchedProviders()).toBe(false)
  })

  it("autocaptures obvious sign-up links as sign_up_click intent", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(
      managedTarget({
        href: "https://example.com/signup?invite=private",
        text: "Start privately"
      })
    )

    const signups = runtime.requests.filter((request) => request.body.eventName === "sign_up_click")
    expect(signups).toHaveLength(1)
    expect(signups[0]?.body.properties).toEqual({
      cta_id: "auto_signup",
      cta_location: "page",
      destination_path: "/signup/"
    })
    expect(runtime.requests.filter((request) => request.body.eventName === "site_click")).toEqual([])
    expect(JSON.stringify(signups[0]?.body)).not.toMatch(/invite=|Start privately/)
    expect(runtime.touchedProviders()).toBe(false)
  })

  it.each(["navigation", "hero", "pricing", "final-cta", "x", "x".repeat(64)])(
    "preserves bounded download placement %s on one canonical event (Infinite only)",
    (ctaLocation) => {
      const runtime = executeTag({
        siteSourceKey: "site_public_123",
        consent: "granted"
      })
      expect(runtime.tag.match(/document\.addEventListener\("click"/g)).toHaveLength(1)

      runtime.click(
        managedTarget({
          href: "https://example.com/download?campaign=private#fragment",
          downloadLocation: ctaLocation,
          text: "Do not collect this download text"
        })
      )

      const downloadRequests = runtime.requests.filter(
        (request) => request.body.eventName === "app_download_click"
      )
      expect(downloadRequests).toHaveLength(1)
      expect(downloadRequests[0]?.body.properties).toEqual({
        cta_id: "auto_download",
        cta_location: ctaLocation,
        destination_path: "/download"
      })
      expect(JSON.stringify(downloadRequests[0]?.body)).not.toMatch(
        /campaign=|fragment|Do not collect/
      )
      expect(runtime.touchedProviders()).toBe(false)
    }
  )

  it("prefers the canonical CTA location attribute without duplicating the download event", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(
      managedTarget({
        href: "https://example.com/download",
        downloadLocation: "legacy",
        downloadAnalyticsLocation: "canonical"
      })
    )

    expect(runtime.requests.filter((request) => request.body.eventName === "site_click")).toEqual([])
    expect(
      runtime.requests.filter((request) => request.body.eventName === "app_download_click")
    ).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({
          properties: {
            cta_id: "auto_download",
            cta_location: "canonical",
            destination_path: "/download"
          }
        })
      })
    ])
  })

  it.each([
    ["empty", ""],
    ["spaces", "hero banner"],
    ["at sign", "hero@example"],
    ["question mark", "hero?campaign=private"],
    ["query-like content", "cta_location=hero"],
    ["Unicode", "café"],
    ["over 64 characters", "x".repeat(65)]
  ])("ignores %s download placement while retaining one canonical download", (_case, value) => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(
      managedTarget({
        href: "https://example.com/download",
        downloadLocation: value
      })
    )

    const downloadRequests = runtime.requests.filter(
      (request) => request.body.eventName === "app_download_click"
    )
    expect(downloadRequests).toHaveLength(1)
    expect(downloadRequests[0]?.body.properties).toEqual({
      cta_id: "auto_download",
      destination_path: "/download"
    })
    expect(runtime.touchedProviders()).toBe(false)
  })

  it.each([
    ["free-form text", "free form text", "hero"],
    ["at sign", "email@example.com", "hero"],
    ["question mark", "pricing?plan=pro", "hero"],
    ["query-like content", "pricing", "cta_location=hero"],
    ["Unicode", "pricing", "café"]
  ])("rejects %s in managed CTA structural tokens", (_case, ctaId, ctaLocation) => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted"
    })

    runtime.click(managedTarget({ ctaId, ctaLocation }))

    expect(runtime.requests.map((request) => request.body.eventName)).toEqual(["site_page_view"])
  })

  it("suppresses Infinite under DNT/GPC or denied consent and reacts to consent changes — without ever touching a provider's consent", () => {
    // DNT with NO recorded decision: the global signal is the default and suppresses.
    const dnt = executeTag({
      siteSourceKey: "site_public_123",
      dnt: "1"
    })
    expect(dnt.requests).toEqual([])
    // 0.6.0: the runtime no longer opts PostHog out / denies GA4 on the site's behalf — providers
    // own their own consent (full native bootstraps).
    expect(dnt.touchedProviders()).toBe(false)

    const denied = executeTag({
      siteSourceKey: "site_public_123",
      consent: "denied"
    })
    expect(denied.requests).toEqual([])
    denied.setConsent(true)
    expect(denied.requests.map((request) => request.body.eventName)).toEqual(["site_page_view"])
    expect(denied.touchedProviders()).toBe(false)

    // GPC visitor with a stored denial: suppressed — until they explicitly grant.
    // The site-specific decision overrides the global signal (GPC-spec precedence).
    const gpc = executeTag({
      siteSourceKey: "site_public_123",
      consent: "denied",
      gpc: true
    })
    expect(gpc.requests).toEqual([])
    gpc.setConsent(true)
    expect(gpc.requests.map((request) => request.body.eventName)).toEqual(["site_page_view"])
    expect(gpc.touchedProviders()).toBe(false)

    // A revocation stops Infinite; an unwritable storage still governs the page in memory.
    const failedStorage = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      consentWriteFails: true
    })
    expect(failedStorage.requests).toHaveLength(1)
    failedStorage.setConsent(false)
    failedStorage.history.pushState({}, "", "/tools")
    expect(failedStorage.requests).toHaveLength(1)
    expect(failedStorage.touchedProviders()).toBe(false)
  })

  it("ignores a consent dispatch that no user gesture preceded (forged-event gate)", () => {
    // A background script silently dispatching consent must NOT defeat the privacy signal.
    const forged = executeTag({
      siteSourceKey: "site_public_123",
      consentMode: "not_required",
      gpc: true
    })
    forged.setConsentWithoutGesture(true)
    expect(forged.requests).toEqual([])

    // The same grant WITH a preceding gesture is the legitimate banner path and works.
    forged.setConsent(true)
    expect(forged.requests.map((request) => request.body.eventName)).toEqual(["site_page_view"])
  })

  it("lets an explicit decision override the global privacy signal on a not_required site (GPC banner flow)", () => {
    // A GPC visitor on a not_required site is suppressed by default…
    const visitor = executeTag({
      siteSourceKey: "site_public_123",
      consentMode: "not_required",
      gpc: true
    })
    expect(visitor.requests).toEqual([])

    // …until they explicitly allow: the site-specific choice wins over the global default.
    visitor.setConsent(true)
    expect(visitor.requests.map((request) => request.body.eventName)).toEqual(["site_page_view"])

    // The decision persists and governs the next visit from the first paint.
    const nextVisit = executeTag({
      siteSourceKey: "site_public_123",
      consentMode: "not_required",
      gpc: true,
      consent: "granted"
    })
    expect(nextVisit.requests.map((request) => request.body.eventName)).toEqual(["site_page_view"])

    // An explicit NO sticks even for a visitor with no privacy signal at all.
    const declined = executeTag({
      siteSourceKey: "site_public_123",
      consentMode: "not_required",
      consent: "denied"
    })
    expect(declined.requests).toEqual([])
  })

  it.each([
    ["https://example.com/", "/"],
    ["https://example.com/privacy", "/privacy/"],
    ["https://example.com/privacy/", "/privacy/"],
    ["https://example.com//tools//", "/tools/"],
    ["https://example.com/download", "/download"],
    ["https://example.com/download/", "/download"],
    ["https://example.com/LICENSE", "/LICENSE"],
    ["https://example.com/asset/app.js?x=1", "/asset/app.js"]
  ])("matches the canonical path contract for %s", (href, expected) => {
    const runtime = executeTag({
      href,
      siteSourceKey: "site_public_123",
      consent: "granted"
    })
    expect(runtime.requests[0]?.body.url).toBe(`https://example.com${expected}`)
    expect(parseLikeCloud("https://example.com", runtime.requests[0]!.body).path).toBe(expected)
  })

  it("emits only from validated production hosts and handles IPv6 loopback", () => {
    const production = executeTag({
      href: "https://infinite-production.vercel.app/",
      siteSourceKey: "site_public_123",
      consent: "granted",
      productionHosts: ["infinite-production.vercel.app", "example.com"]
    })
    expect(production.requests).toHaveLength(1)

    for (const href of [
      "http://localhost:3000/",
      "http://[::1]:3000/",
      "https://feature-abc.vercel.app/",
      "https://preview.example.net/"
    ]) {
      const runtime = executeTag({
        href,
        siteSourceKey: "site_public_123",
        consent: "granted",
        productionHosts: ["infinite-production.vercel.app", "example.com"]
      })
      expect(runtime.requests).toEqual([])
      expect(runtime.touchedProviders()).toBe(false)
    }
  })

  it("fails closed when the production host allowlist is empty (render-time: a source key with no hosts is rejected outright)", () => {
    expect(() =>
      renderInfiniteBrowserTag({
        siteSourceKey: "site_public_123",
        collectPath: "/infinite/events/collect",
        respectDnt: true,
        consent: { mode: "not_required" },
        productionHosts: []
      })
    ).toThrow(/at least one validated production host/)
    const runtime = executeTag({
      consent: "granted",
      productionHosts: []
    })

    expect(runtime.requests).toEqual([])
    expect(runtime.touchedProviders()).toBe(false)
  })
})

describe("sign_up_click — marked sign-up intent", () => {
  it("emits sign_up_click for a marked anchor with structural markers + destination — the ledger never sees the outcome name sign_up", () => {
    const runtime = executeTag({ siteSourceKey: "site_public_123", consent: "granted" })
    runtime.click(
      signupTarget({
        href: "https://example.com/signup",
        ctaId: "signup_primary",
        ctaLocation: "hero"
      })
    )
    const signupRequests = runtime.requests.filter(
      (request) => request.body.eventName === "sign_up_click"
    )
    expect(signupRequests).toHaveLength(1)
    expect(signupRequests[0]?.body.properties).toEqual({
      cta_id: "signup_primary",
      cta_location: "hero",
      destination_path: "/signup/"
    })
    // The cloud parser's shape holds (same origin, normalized path).
    expect(() =>
      parseLikeCloud("https://example.com", signupRequests[0]!.body)
    ).not.toThrow()
    // The ledger itself NEVER sees the outcome name — and (0.6.0) nothing is forwarded into GA4
    // or PostHog under any name.
    expect(
      runtime.requests.filter((request) => request.body.eventName === "sign_up")
    ).toHaveLength(0)
    expect(runtime.touchedProviders()).toBe(false)
  })

  it("takes precedence over the generic CTA lane — one observation, ONE event", () => {
    const runtime = executeTag({ siteSourceKey: "site_public_123", consent: "granted" })
    runtime.click(
      signupTarget({
        href: "https://example.com/signup",
        ctaId: "signup_primary",
        ctaLocation: "hero",
        alsoGenericCta: true
      })
    )
    expect(
      runtime.requests.filter((request) => request.body.eventName === "sign_up_click")
    ).toHaveLength(1)
    expect(
      runtime.requests.filter((request) => request.body.eventName === "site_click")
    ).toHaveLength(0)
  })

  it("emits sign_up_click for a marked form submit — markers optional, no destination", () => {
    const runtime = executeTag({ siteSourceKey: "site_public_123", consent: "granted" })
    runtime.submit(signupFormTarget({ ctaLocation: "footer" }))
    const signupRequests = runtime.requests.filter(
      (request) => request.body.eventName === "sign_up_click"
    )
    expect(signupRequests).toHaveLength(1)
    expect(signupRequests[0]?.body.properties).toEqual({ cta_location: "footer" })

    runtime.submit(signupFormTarget({}))
    expect(
      runtime.requests.filter((request) => request.body.eventName === "sign_up_click")
    ).toHaveLength(2)
    // An unmarked form emits nothing.
    runtime.submit(signupFormTarget({ marked: false }))
    expect(
      runtime.requests.filter((request) => request.body.eventName === "sign_up_click")
    ).toHaveLength(2)
  })

  it("drops non-structural marker values and stays silent without consent", () => {
    const runtime = executeTag({ siteSourceKey: "site_public_123", consent: "granted" })
    runtime.click(
      signupTarget({ href: "https://example.com/signup", ctaId: "free form text" })
    )
    const signupRequests = runtime.requests.filter(
      (request) => request.body.eventName === "sign_up_click"
    )
    expect(signupRequests).toHaveLength(1)
    expect(signupRequests[0]?.body.properties).toEqual({ destination_path: "/signup/" })

    const denied = executeTag({ siteSourceKey: "site_public_123", consent: "denied" })
    denied.click(signupTarget({ href: "https://example.com/signup" }))
    denied.submit(signupFormTarget({}))
    expect(denied.requests).toHaveLength(0)
  })
})

describe("parameterized download destination", () => {
  const downloadAnchor = (href: string) =>
    managedTarget({ href, downloadLocation: "hero" })

  it("keeps the /download default conversion destination when unconfigured", () => {
    const runtime = executeTag({ siteSourceKey: "site_public_123", consent: "granted" })
    runtime.click(downloadAnchor("https://example.com/download"))
    const downloads = runtime.requests.filter(
      (request) => request.body.eventName === "app_download_click"
    )
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.body.properties).toEqual({
      cta_id: "auto_download",
      cta_location: "hero",
      destination_path: "/download"
    })
  })

  it("captures the CONFIGURED destination and emits its normalized path", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      downloadDestinationPath: "/get-app"
    })
    runtime.click(downloadAnchor("https://example.com/get-app"))
    const downloads = runtime.requests.filter(
      (request) => request.body.eventName === "app_download_click"
    )
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.body.properties).toEqual({
      cta_id: "auto_get-app",
      cta_location: "hero",
      destination_path: "/get-app/"
    })
  })

  it("captures the configured destination with the explicit or synthesized CTA id", () => {
    const marked = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      downloadDestinationPath: "/checkout"
    })
    marked.click(
      managedTarget({
        href: "https://example.com/checkout?plan=day-ones",
        ctaId: "buy_day_ones",
        ctaLocation: "pricing"
      })
    )
    expect(
      marked.requests.find((request) => request.body.eventName === "app_download_click")?.body
        .properties
    ).toEqual({
      cta_id: "buy_day_ones",
      cta_location: "pricing",
      destination_path: "/checkout/"
    })

    const unmarked = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      downloadDestinationPath: "/checkout"
    })
    unmarked.click(downloadAnchor("https://example.com/checkout?plan=studio"))
    expect(
      unmarked.requests.find((request) => request.body.eventName === "app_download_click")?.body
        .properties
    ).toEqual({
      cta_id: "auto_checkout",
      cta_location: "hero",
      destination_path: "/checkout/"
    })
  })

  it("the configured destination REPLACES the default — /download no longer captures", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_123",
      consent: "granted",
      downloadDestinationPath: "/get-app"
    })
    runtime.click(downloadAnchor("https://example.com/download"))
    expect(
      runtime.requests.filter((request) => request.body.eventName === "app_download_click")
    ).toHaveLength(0)
  })

  it("render-time validation rejects non-root-relative or query-bearing destinations", () => {
    const base = {
      siteSourceKey: "site_public_123",
      collectPath: "/infinite/events/collect",
      respectDnt: true,
      consent: { mode: "not_required" } as const,
      productionHosts: ["example.com"]
    }
    for (const downloadDestinationPath of [
      "get-app",
      "//evil.example/get-app",
      "/get-app?src=1",
      "/get-app#frag",
      "/get app"
    ]) {
      expect(() =>
        renderInfiniteBrowserTag({ ...base, downloadDestinationPath })
      ).toThrow(/downloadDestinationPath/)
    }
  })
})

// The browser→desktop handoff context: the ONLY thing the open-core runtime exposes to the page.
// It is attribution context, not a capability — no track(), no dispatch, no cloud knowledge, and
// (critically) no NEW identity: it hands back the same random localStorage/sessionStorage ids the
// runtime already uses for its own events, and only for a consent-qualified visitor on a verified
// production host of a configured source.
describe("window.__infiniteHandoffContext — the consent-gated browser→desktop handoff context", () => {
  it("returns the runtime's OWN ids and the canonical url for a consented visitor", () => {
    const runtime = executeTag({
      href: "https://example.com/pricing?secret=yes#section",
      siteSourceKey: "site_public_fixture",
      consent: "granted"
    })

    const context = runtime.window.__infiniteHandoffContext?.()
    expect(context).toEqual({
      siteSourceKey: "site_public_fixture",
      anonymousId: expect.any(String),
      sessionId: expect.any(String),
      url: "https://example.com/pricing/"
    })
    // Same canonicalization as every emitted event: no query string, no fragment.
    expect(JSON.stringify(context)).not.toContain("secret=yes")
    expect(JSON.stringify(context)).not.toContain("#section")

    // No new identity: exactly the ids the runtime already used for its own page view.
    expect(context?.anonymousId).toBe(runtime.requests[0]?.body.anonymousId)
    expect(context?.sessionId).toBe(runtime.requests[0]?.body.sessionId)
    expect(runtime.storedIds()).toEqual({
      anonymousId: context?.anonymousId,
      sessionId: context?.sessionId
    })

    // Reading the context is not an observation: nothing was sent, no provider touched.
    expect(runtime.requests).toHaveLength(1)
    expect(runtime.touchedProviders()).toBe(false)
  })

  it("is stable across calls; a SPA route change keeps the ids and follows the current path", () => {
    const runtime = executeTag({
      href: "https://example.com/pricing",
      siteSourceKey: "site_public_fixture",
      consent: "granted"
    })

    expect(runtime.window.__infiniteHandoffContext?.()).toEqual(
      runtime.window.__infiniteHandoffContext?.()
    )

    const before = runtime.window.__infiniteHandoffContext?.()
    runtime.history.pushState({}, "", "/download")
    const after = runtime.window.__infiniteHandoffContext?.()
    expect(after?.anonymousId).toBe(before?.anonymousId)
    expect(after?.sessionId).toBe(before?.sessionId)
    expect(after?.url).toBe("https://example.com/download")
  })

  it("returns null under a stored denial and under a DNT/GPC default — minting no identity", () => {
    const denied = executeTag({
      siteSourceKey: "site_public_fixture",
      consent: "denied"
    })
    expect(denied.window.__infiniteHandoffContext?.()).toBeNull()
    // A visitor who said no is not given a visitor id by the accessor.
    expect(denied.storedIds()).toEqual({ anonymousId: null, sessionId: null })

    // A not_required site emits by default — so DNT/GPC, not the mode, is what nulls these.
    const baseline = executeTag({
      siteSourceKey: "site_public_fixture",
      consentMode: "not_required"
    })
    expect(baseline.window.__infiniteHandoffContext?.()).not.toBeNull()

    const dnt = executeTag({
      siteSourceKey: "site_public_fixture",
      consentMode: "not_required",
      dnt: "1"
    })
    expect(dnt.window.__infiniteHandoffContext?.()).toBeNull()
    expect(dnt.storedIds()).toEqual({ anonymousId: null, sessionId: null })

    const gpc = executeTag({
      siteSourceKey: "site_public_fixture",
      consentMode: "not_required",
      gpc: true
    })
    expect(gpc.window.__infiniteHandoffContext?.()).toBeNull()
    expect(gpc.storedIds()).toEqual({ anonymousId: null, sessionId: null })

    // Dormant required mode (no decision recorded yet) is a null too, not an empty object.
    const undecided = executeTag({ siteSourceKey: "site_public_fixture" })
    expect(undecided.window.__infiniteHandoffContext?.()).toBeNull()
  })

  it("follows the live decision: a gesture-backed grant makes it non-null, a revocation nulls it", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_fixture",
      consent: "denied"
    })
    expect(runtime.window.__infiniteHandoffContext?.()).toBeNull()

    runtime.setConsent(true)
    expect(runtime.window.__infiniteHandoffContext?.()).toEqual({
      siteSourceKey: "site_public_fixture",
      anonymousId: expect.any(String),
      sessionId: expect.any(String),
      url: "https://example.com/privacy/"
    })

    runtime.setConsent(false)
    expect(runtime.window.__infiniteHandoffContext?.()).toBeNull()
  })

  it("honors the forged-event gate: a gesture-less grant never opens the context", () => {
    // Same gate as collection — a background script cannot silently defeat a privacy signal and
    // then read a handoff context out of the page.
    const forged = executeTag({
      siteSourceKey: "site_public_fixture",
      consentMode: "not_required",
      gpc: true
    })
    forged.setConsentWithoutGesture(true)
    expect(forged.window.__infiniteHandoffContext?.()).toBeNull()
    expect(forged.storedIds()).toEqual({ anonymousId: null, sessionId: null })

    // The same grant behind a real gesture is the legitimate banner path and opens it.
    forged.setConsent(true)
    expect(forged.window.__infiniteHandoffContext?.()).not.toBeNull()
  })

  it("is NOT INSTALLED without a source, off a verified host, on loopback, or under automation", () => {
    expect(executeTag({ consent: "granted" }).window.__infiniteHandoffContext).toBeUndefined()

    for (const href of [
      "https://preview.example.net/",
      "https://feature-abc.vercel.app/",
      "http://localhost:3000/",
      "http://[::1]:3000/"
    ]) {
      const runtime = executeTag({
        href,
        siteSourceKey: "site_public_fixture",
        consent: "granted"
      })
      expect(runtime.window.__infiniteHandoffContext).toBeUndefined()
    }

    const driven = executeTag({
      siteSourceKey: "site_public_fixture",
      consent: "granted",
      webdriver: true
    })
    expect(driven.window.__infiniteHandoffContext).toBeUndefined()
  })

  it("exposes attribution context only — no track, dispatch, workspace, authority, or environment", () => {
    const runtime = executeTag({
      siteSourceKey: "site_public_fixture",
      consent: "granted"
    })
    const context = runtime.window.__infiniteHandoffContext?.()

    expect(Object.keys(context ?? {}).sort()).toEqual([
      "anonymousId",
      "sessionId",
      "siteSourceKey",
      "url"
    ])
    for (const forbidden of [
      "track",
      "capture",
      "emit",
      "send",
      "dispatch",
      "workspaceId",
      "authority",
      "environment",
      "collectPath",
      "claim",
      "consent"
    ]) {
      expect(context).not.toHaveProperty(forbidden)
    }

    // The accessor is a plain function with nothing hanging off it.
    expect(typeof runtime.window.__infiniteHandoffContext).toBe("function")
    expect(Object.keys(runtime.window.__infiniteHandoffContext as object)).toEqual([])

    // The rendered tag carries no cloud endpoint knowledge for the handoff.
    expect(runtime.tag).not.toContain("/api/analytics/attribution")
    expect(runtime.tag).not.toContain("infinite://")
  })
})
