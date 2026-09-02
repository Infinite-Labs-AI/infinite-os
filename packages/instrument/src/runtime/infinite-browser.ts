import type { InfiniteBrowserConfig, InfiniteHandoffContext } from "../types.js"

const RUNTIME_ATTRIBUTE = 'data-infinite-runtime="managed"'

export function renderInfiniteBrowserTag(config: InfiniteBrowserConfig): string {
  if (
    !config.collectPath.startsWith("/") ||
    config.collectPath.startsWith("//") ||
    config.collectPath.includes("?") ||
    config.collectPath.includes("#") ||
    config.collectPath.includes("\\") ||
    !/^\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*$/.test(config.collectPath) ||
    /^\/(?:tracking|sdk)(?:\/|$)/.test(config.collectPath)
  ) {
    throw new Error(
      "Infinite requires a root-relative same-origin collectPath outside legacy loader routes."
    )
  }
  if (config.siteSourceKey !== undefined && !/^site_[A-Za-z0-9_-]+$/.test(config.siteSourceKey)) {
    throw new Error("Infinite requires a valid public siteSourceKey (expected site_...).")
  }
  if (
    config.downloadDestinationPath !== undefined &&
    (!config.downloadDestinationPath.startsWith("/") ||
      config.downloadDestinationPath.startsWith("//") ||
      config.downloadDestinationPath.includes("?") ||
      config.downloadDestinationPath.includes("#") ||
      config.downloadDestinationPath.includes("\\") ||
      !/^\/[A-Za-z0-9._~%-]+(?:\/[A-Za-z0-9._~%-]+)*$/.test(config.downloadDestinationPath))
  ) {
    throw new Error(
      "Infinite requires a root-relative downloadDestinationPath without query or hash."
    )
  }
  if (
    !Array.isArray(config.productionHosts) ||
    config.productionHosts.some(
      (host) =>
        typeof host !== "string" ||
        host.length === 0 ||
        host !== host.toLowerCase() ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
          host
        )
    )
  ) {
    throw new Error("Infinite requires validated lowercase productionHosts.")
  }
  if (config.siteSourceKey !== undefined && config.productionHosts.length === 0) {
    throw new Error("Infinite requires at least one validated production host.")
  }
  const serialized = JSON.stringify(config)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
  return `<script ${RUNTIME_ATTRIBUTE}>;(${infiniteBrowserRuntime.toString()})(${serialized});</script>`
}

// The Infinite browser runtime (0.6.0 — the consolidated truth-train release):
//   • emits ONLY to Infinite's same-origin collect route. Mirror mode is GONE: the runtime never
//     forwards browser events into PostHog or GA4 and never touches their consent / opt-in / config
//     APIs (founder decision: healthy providers stay fully independent — the GA4 mirror already
//     duplicated enhanced-measurement page_views on SPAs, and a provider that the installer had
//     "reduced" was a provider nobody else could trust). It binds immediately, waiting on nothing;
//   • emits NOTHING when `navigator.webdriver` is true (headless / automation-driven browsers —
//     Lighthouse, Playwright, Puppeteer — are not visitors and must not become page views);
//   • stamps `nav` on every site_page_view: "navigate" for the initial document load, "history"
//     for History-API route changes (pushState / replaceState / popstate). The bounded enum lets the
//     cloud count INITIAL browser page views (the only numerator that can honestly be compared with
//     server document requests) while keeping the pathname-only dedupe exactly as before.
//   The consent contract is UNCHANGED: DNT/GPC suppress by default; the site's explicit decision
//   (the infinite:analytics-consent-change event, gesture-gated) overrides it in either direction;
//   `required` mode stays dormant until granted.
function infiniteBrowserRuntime(config: InfiniteBrowserConfig): void {
  type RuntimeWindow = Window & {
    __infiniteAnalyticsRuntime?: boolean
    __infiniteHandoffContext?: () => InfiniteHandoffContext | null
  }

  const runtimeWindow = window as RuntimeWindow
  if (runtimeWindow.__infiniteAnalyticsRuntime) return
  runtimeWindow.__infiniteAnalyticsRuntime = true

  // Automation-driven browsers declare themselves (WebDriver spec): never a visit, never an event.
  if ((navigator as Navigator & { webdriver?: boolean }).webdriver === true) return

  const isLoopbackHost =
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1" ||
    location.hostname === "::1" ||
    location.hostname === "[::1]"
  const isVerifiedProductionHost =
    config.productionHosts.length > 0 &&
    config.productionHosts.includes(location.hostname.toLowerCase())
  if (isLoopbackHost || !isVerifiedProductionHost) return

  const structuralTokenPattern = /^[A-Za-z0-9_-]{1,64}$/

  function normalizePath(raw: string): string {
    const pathname = new URL(raw, location.href).pathname.replace(/\/{2,}/g, "/")
    const stripped = pathname === "/" ? "/" : pathname.replace(/\/+$/, "") || "/"
    if (stripped === "/" || stripped === "/download" || stripped === "/LICENSE") return stripped
    const lastSegment = stripped.slice(stripped.lastIndexOf("/") + 1)
    return lastSegment.includes(".") ? stripped : stripped + "/"
  }

  // The workspace's conversion destination for download-intent clicks, normalized once so every
  // comparison (and the emitted destination_path property) uses the same canonical spelling the
  // cloud ingest normalizes to. Default: the platform's /download.
  const conversionDestinationPath = normalizePath(config.downloadDestinationPath || "/download")

  function safeClosest(target: Element, selector: string): HTMLElement | null {
    try {
      return target.closest(selector) as HTMLElement | null
    } catch {
      return null
    }
  }

  function structuralAttribute(element: Element | null | undefined, name: string): string | undefined {
    if (!element || typeof (element as { getAttribute?: unknown }).getAttribute !== "function") {
      return undefined
    }
    const value = (element as HTMLElement).getAttribute(name)
    return value && structuralTokenPattern.test(value) ? value : undefined
  }

  function automaticToken(prefix: string, value: string): string {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
    return (prefix + "_" + (cleaned || "link")).slice(0, 64).replace(/_+$/, "") || prefix + "_link"
  }

  function tokenFromPath(path: string): string {
    const stem = path === "/" ? "home" : path.replace(/^\/+|\/+$/g, "")
    return automaticToken("auto", stem)
  }

  function externalCtaId(destination: URL): string | null {
    if (destination.protocol !== "https:" && destination.protocol !== "http:") return null
    const host = destination.hostname.toLowerCase().replace(/^www\./, "")
    if (host === "calendly.com" || host.endsWith(".calendly.com")) return "external_booking"
    if (host === "cal.com" || host.endsWith(".cal.com")) return "external_booking"
    return "external_link"
  }

  function externalPath(destination: URL): string {
    return destination.pathname.replace(/\/{2,}/g, "/") || "/"
  }

  function externalCheckoutDestination(destination: URL): { ctaId: string; path: string } | null {
    if (destination.protocol !== "https:" && destination.protocol !== "http:") return null
    const host = destination.hostname.toLowerCase().replace(/^www\./, "")
    const path = externalPath(destination)
    if (host === "buy.stripe.com" || host === "book.stripe.com" || host === "donate.stripe.com") {
      return { ctaId: "external_stripe_payment_link", path: "/external/stripe_payment_link" }
    }
    if (host === "checkout.stripe.com" && path.startsWith("/c/")) {
      return { ctaId: "external_stripe_checkout", path: "/external/stripe_checkout" }
    }
    if (host === "invoice.stripe.com" && path.startsWith("/i/")) {
      return { ctaId: "external_stripe_invoice", path: "/external/stripe_invoice" }
    }
    return null
  }

  function automaticLocation(target: Element, preferred: Array<Element | null>): string {
    for (const element of preferred) {
      const explicit = structuralAttribute(element, "data-analytics-cta-location")
      if (explicit) return explicit
    }
    const section = safeClosest(target, "header,nav,main,footer,aside")
    const tag = String((section as { tagName?: unknown } | null)?.tagName ?? "").toLowerCase()
    if (
      tag === "header" ||
      tag === "nav" ||
      tag === "main" ||
      tag === "footer" ||
      tag === "aside"
    ) {
      return tag
    }
    return "page"
  }

  function markedCtaProperties(
    marked: HTMLElement | null,
    target: Element,
    anchor: HTMLAnchorElement | null
  ): Record<string, string> | null {
    if (!marked) return null
    const rawCtaId = marked.getAttribute("data-analytics-cta-id")
    const rawCtaLocation = marked.getAttribute("data-analytics-cta-location")
    const ctaId = structuralAttribute(marked, "data-analytics-cta-id")
    const ctaLocation =
      structuralAttribute(marked, "data-analytics-cta-location") ||
      automaticLocation(target, [marked, anchor])
    if (
      (rawCtaId !== null && !ctaId) ||
      (rawCtaLocation !== null && rawCtaLocation !== "" && !structuralAttribute(marked, "data-analytics-cta-location"))
    ) {
      return null
    }
    return { cta_id: ctaId ?? tokenFromPath("/"), cta_location: ctaLocation }
  }

  function isSignupDestination(path: string): boolean {
    return [
      "/signup/",
      "/sign-up/",
      "/register/",
      "/join/",
      "/get-started/",
      "/start/",
      "/trial/"
    ].includes(path)
  }

  function destinationForAnchor(anchor: HTMLAnchorElement | null): URL | null {
    if (!anchor) return null
    try {
      return new URL(anchor.href, location.href)
    } catch {
      return null
    }
  }

  function automaticClickProperties(
    target: Element,
    anchor: HTMLAnchorElement | null,
    destination: URL | null
  ): Record<string, string> | null {
    const marked = safeClosest(target, "[data-analytics-cta-id]")
    const markedProperties = markedCtaProperties(marked, target, anchor)
    if (marked && !markedProperties) return null

    const properties: Record<string, string> = markedProperties ?? {
      cta_id: "button",
      cta_location: automaticLocation(target, [anchor])
    }
    if (destination) {
      if (destination.origin === location.origin) {
        const destinationPath = normalizePath(destination.href)
        properties.cta_id = properties.cta_id === "button" ? tokenFromPath(destinationPath) : properties.cta_id
        properties.destination_path = destinationPath
        return properties
      }
      const externalId = externalCtaId(destination)
      if (!externalId) return null
      properties.cta_id = properties.cta_id === "button" ? externalId : properties.cta_id
      return properties
    }

    const button = safeClosest(target, "button,input[type='button'],input[type='submit'],[role='button']")
    if (!button && !marked) return null
    if (!marked) {
      properties.cta_id = "button"
      properties.cta_location = automaticLocation(target, [button])
    }
    return properties
  }

  function downloadClickProperties(
    target: Element,
    anchor: HTMLAnchorElement,
    destinationPath: string,
    fallbackCtaId?: string,
    fallbackCtaLocation?: string
  ): Record<string, string> {
    const marked = safeClosest(target, "[data-analytics-cta-id]")
    const markedProperties = markedCtaProperties(marked, target, anchor)
    const ctaId = markedProperties?.cta_id ?? fallbackCtaId ?? tokenFromPath(destinationPath)
    const ctaLocation = [
      markedProperties?.cta_location,
      structuralAttribute(anchor, "data-analytics-cta-location"),
      structuralAttribute(anchor, "data-download-location"),
      fallbackCtaLocation
    ].find((value): value is string => typeof value === "string")
    return {
      cta_id: ctaId,
      ...(ctaLocation ? { cta_location: ctaLocation } : {}),
      destination_path: destinationPath
    }
  }

  function checkoutClickProperties(
    target: Element,
    anchor: HTMLAnchorElement,
    destinationPath: string,
    fallbackCtaId: string,
    fallbackCtaLocation: string
  ): Record<string, string> | null {
    const marked = safeClosest(target, "[data-analytics-cta-id]")
    const markedProperties = markedCtaProperties(marked, target, anchor)
    if (marked && !markedProperties) return null
    return {
      cta_id: markedProperties?.cta_id ?? fallbackCtaId,
      cta_location: markedProperties?.cta_location ?? fallbackCtaLocation,
      destination_path: destinationPath
    }
  }

  function cleanReferrerHost(raw: string): string {
    if (!raw) return ""
    try {
      return new URL(raw, location.href).hostname.toLowerCase().replace(/\.$/, "")
    } catch {
      return ""
    }
  }

  function storageId(storage: Storage, key: string): string {
    try {
      const existing = storage.getItem(key)
      if (existing) return existing
      const created = crypto.randomUUID()
      storage.setItem(key, created)
      return created
    } catch {
      return crypto.randomUUID()
    }
  }

  let anonymousId: string | undefined
  let sessionId: string | undefined

  function privacySignalBlocks(): boolean {
    if (!config.respectDnt) return false
    const privacyNavigator = navigator as Navigator & {
      globalPrivacyControl?: boolean
    }
    return privacyNavigator.doNotTrack === "1" || privacyNavigator.globalPrivacyControl === true
  }

  // One key for both consent modes: not_required sites may still record an explicit
  // decision (a GPC/DNT visitor clicking "allow analytics"), and the recorded decision
  // must survive a later switch to required mode.
  const consentStorageKey =
    config.consent.mode === "required" ? config.consent.storageKey : "infinite_analytics_consent"

  let consentOverride: boolean | undefined
  function storedConsentDecision(): boolean | undefined {
    try {
      const value = localStorage.getItem(consentStorageKey)
      if (value === "granted") return true
      if (value === "denied") return false
    } catch {
      // Unreadable storage means no recorded decision.
    }
    return undefined
  }

  function hasConsent(): boolean {
    // The user's explicit site-specific decision takes precedence over the global
    // privacy signal — per the GPC spec, DNT/GPC is the DEFAULT, and a choice the
    // user makes on this site overrides it (in either direction).
    const decision = consentOverride !== undefined ? consentOverride : storedConsentDecision()
    if (decision !== undefined) return decision
    if (privacySignalBlocks()) return false
    return config.consent.mode === "not_required"
  }

  function sendInfinite(payload: Record<string, unknown>): void {
    if (!config.siteSourceKey) return
    const body = JSON.stringify({
      ...payload,
      siteSourceKey: config.siteSourceKey
    })
    if (
      typeof navigator.sendBeacon === "function" &&
      navigator.sendBeacon(config.collectPath, body)
    ) {
      return
    }

    const send = (retry: boolean): void => {
      void fetch(config.collectPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin"
      })
        .then((response) => {
          if (!response.ok && retry) setTimeout(() => send(false), 250)
        })
        .catch(() => {
          if (retry) setTimeout(() => send(false), 250)
        })
    }
    send(true)
  }

  function emit(
    eventName: "site_page_view" | "site_click" | "app_download_click" | "sign_up_click",
    path: string,
    properties?: Record<string, string>
  ): void {
    if (!hasConsent()) return
    const canonicalPath = normalizePath(path)
    anonymousId ??= storageId(localStorage, "infinite_analytics_visitor")
    sessionId ??= storageId(sessionStorage, "infinite_analytics_session")
    const payload: Record<string, unknown> = {
      eventId: crypto.randomUUID(),
      eventName,
      occurredAt: new Date().toISOString(),
      anonymousId,
      sessionId,
      url: location.origin + canonicalPath
    }
    const referrer = cleanReferrerHost(document.referrer)
    if (referrer) payload.referrer = referrer
    if (properties && Object.keys(properties).length > 0) payload.properties = properties
    sendInfinite(payload)
  }

  // One logical page view per canonical path (the pathname-only dedupe) — the initial document
  // load is nav:"navigate"; a History-API route change is nav:"history". A consent grant that
  // arrives after the load re-emits the CURRENT page as the initial view (it IS the first view the
  // runtime was allowed to observe), so `initialView` stays true until a view is actually sent.
  let lastPageViewPath: string | null = null
  let initialView = true
  function emitPageView(): void {
    const path = normalizePath(location.href)
    if (path === lastPageViewPath) return
    if (!hasConsent()) return
    lastPageViewPath = path
    const nav: "navigate" | "history" = initialView ? "navigate" : "history"
    initialView = false
    emit("site_page_view", path, { nav })
  }

  // Bounded properties for a marked sign-up element: the optional structural cta markers, plus a
  // same-origin destination when the marked element is (or wraps) an anchor. Never link text,
  // never form field values — the intent event carries structure only.
  function signupProperties(marked: HTMLElement): Record<string, string> {
    const properties: Record<string, string> = {}
    const ctaId = marked.getAttribute("data-analytics-cta-id")
    const ctaLocation = marked.getAttribute("data-analytics-cta-location")
    if (ctaId && structuralTokenPattern.test(ctaId)) properties.cta_id = ctaId
    if (ctaLocation && structuralTokenPattern.test(ctaLocation)) {
      properties.cta_location = ctaLocation
    }
    const anchor = (
      typeof (marked as { closest?: unknown }).closest === "function"
        ? (marked.closest("a[href]") as HTMLAnchorElement | null)
        : null
    )
    if (anchor) {
      try {
        const destination = new URL(anchor.href, location.href)
        if (destination.origin === location.origin) {
          properties.destination_path = normalizePath(destination.href)
        }
      } catch {
        // A destination is optional; malformed values are omitted.
      }
    }
    return properties
  }

  function bindRuntime(): void {
    const wrapHistory = (method: "pushState" | "replaceState"): void => {
      const original = history[method]
      history[method] = function (this: History, ...args: Parameters<History[typeof method]>) {
        const result = original.apply(this, args)
        emitPageView()
        return result
      } as History[typeof method]
    }
    wrapHistory("pushState")
    wrapHistory("replaceState")
    runtimeWindow.addEventListener("popstate", emitPageView)

    document.addEventListener("click", (event) => {
      const target =
        event.target && typeof (event.target as { closest?: unknown }).closest === "function"
          ? (event.target as Element)
          : null
      if (!target || !hasConsent()) return
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null
      if (anchor) {
        const destination = destinationForAnchor(anchor)
        if (
          destination &&
          destination.origin === location.origin &&
          normalizePath(destination.href) === conversionDestinationPath
        ) {
          emit(
            "app_download_click",
            normalizePath(location.href),
            downloadClickProperties(target, anchor, normalizePath(destination.href))
          )
          return
        }
        if (destination && destination.origin !== location.origin) {
          const externalCheckout = externalCheckoutDestination(destination)
          if (externalCheckout) {
            const properties = checkoutClickProperties(
              target,
              anchor,
              externalCheckout.path,
              externalCheckout.ctaId,
              automaticLocation(target, [anchor])
            )
            if (properties) emit("site_click", normalizePath(location.href), properties)
            return
          }

          const markedCheckout = safeClosest(target, '[data-conversion="checkout"]')
          if (markedCheckout) {
            const properties = checkoutClickProperties(
              target,
              anchor,
              "/external/marked_checkout",
              "external_checkout",
              automaticLocation(target, [markedCheckout, anchor])
            )
            if (properties) emit("site_click", normalizePath(location.href), properties)
            return
          }
        }
      }

      // Marked sign-up intent: an anchor/button (or anything inside one) carrying
      // data-conversion="signup". Takes precedence over the generic CTA lane — one observation,
      // one event (a marked element never double-emits site_click for the same click). The
      // properties stay strictly structural: optional cta markers + a same-origin destination.
      const signup = target.closest('[data-conversion="signup"]') as HTMLElement | null
      if (signup) {
        emit("sign_up_click", normalizePath(location.href), signupProperties(signup))
        return
      }

      const destination = destinationForAnchor(anchor)
      if (anchor && destination && destination.origin === location.origin) {
        const destinationPath = normalizePath(destination.href)
        if (isSignupDestination(destinationPath)) {
          const properties = automaticClickProperties(target, anchor, destination) ?? {}
          emit("sign_up_click", normalizePath(location.href), {
            ...properties,
            cta_id: properties.cta_id ?? tokenFromPath(destinationPath),
            cta_location: properties.cta_location ?? automaticLocation(target, [anchor]),
            destination_path: destinationPath
          })
          return
        }
      }

      const properties = automaticClickProperties(target, anchor, destination)
      if (!properties) {
        return
      }
      emit("site_click", normalizePath(location.href), properties)
    })

    // Marked sign-up FORMS: a submit on (or inside) form[data-conversion="signup"] is the intent
    // observation for form-based sign-ups — same event, same bounded properties as the click lane
    // (minus a destination: a form submit's target is not a navigation the visitor chose).
    document.addEventListener("submit", (event) => {
      const target =
        event.target && typeof (event.target as { closest?: unknown }).closest === "function"
          ? (event.target as Element)
          : null
      if (!target || !hasConsent()) return
      const form = target.closest('form[data-conversion="signup"]') as HTMLElement | null
      if (!form) return
      const properties: Record<string, string> = {}
      const ctaId = form.getAttribute("data-analytics-cta-id")
      const ctaLocation = form.getAttribute("data-analytics-cta-location")
      if (ctaId && structuralTokenPattern.test(ctaId)) properties.cta_id = ctaId
      if (ctaLocation && structuralTokenPattern.test(ctaLocation)) {
        properties.cta_location = ctaLocation
      }
      emit("sign_up_click", normalizePath(location.href), properties)
    })

    // A consent decision must follow a genuine user gesture. Any same-origin script can
    // dispatch the consent event, and — since explicit decisions now override GPC/DNT —
    // a silent dispatch could otherwise persistently defeat a visitor's privacy signal.
    // A real consent UI always produces a pointerdown/keydown moments before dispatching;
    // a background script does not.
    let lastGestureAt = 0
    const recordGesture = () => {
      lastGestureAt = Date.now()
    }
    document.addEventListener("pointerdown", recordGesture, true)
    document.addEventListener("keydown", recordGesture, true)

    runtimeWindow.addEventListener("infinite:analytics-consent-change", (event) => {
      // Accepted in EVERY consent mode: a not_required site still needs to record the
      // explicit decision of a GPC/DNT visitor (the only visitors it suppresses).
      if (Date.now() - lastGestureAt > 10000) return
      const detail = (event as CustomEvent<{ granted?: boolean }>).detail
      consentOverride = detail?.granted === true
      try {
        localStorage.setItem(consentStorageKey, detail?.granted ? "granted" : "denied")
      } catch {
        // The in-memory decision still governs this page when storage is unavailable.
      }
      if (hasConsent()) {
        emitPageView()
      } else {
        // A revocation: the next grant re-observes the page as a fresh initial view.
        lastPageViewPath = null
        initialView = true
      }
    })

    emitPageView()
  }

  // The browser→desktop handoff context — the ONLY thing this runtime exposes to the page, and
  // the narrowest thing that can carry a browser journey into a native app. The site reads it at
  // most once, when a visitor clicks Download, to mint a one-time attribution claim.
  //
  // Deliberately not a capability: no `track()`, no dispatch, no emitter, no workspace /
  // authority / environment / endpoint, and no knowledge that a cloud exists. It also mints NO
  // new identity — it returns the same random localStorage/sessionStorage ids the runtime already
  // uses for its own events, so reading it can never create a visitor the site would not have had.
  //
  // Installed only for a configured source (the checks above already returned for loopback,
  // unverified hosts and automation-driven browsers), so a page with no Infinite source, or on an
  // unverified host, sees no accessor at all. Consent is re-checked on EVERY call — a stored
  // denial, a DNT/GPC default, or a revocation dispatched a moment ago returns null, never an
  // identity — which is why this is a live accessor and not a frozen value.
  if (config.siteSourceKey) {
    const siteSourceKey = config.siteSourceKey
    runtimeWindow.__infiniteHandoffContext = () => {
      if (!hasConsent()) return null
      anonymousId ??= storageId(localStorage, "infinite_analytics_visitor")
      sessionId ??= storageId(sessionStorage, "infinite_analytics_session")
      return {
        siteSourceKey,
        anonymousId,
        sessionId,
        url: location.origin + normalizePath(location.href)
      }
    }
  }

  // Bind immediately: the runtime waits on no provider global (there is nothing to wait for).
  bindRuntime()
}
