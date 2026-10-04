import { UNSAFE_CAMPAIGN_SOURCE } from "../conversions/scrub.js"
import type { InfiniteBrowserConfig, InfiniteHandoffContext } from "../types.js"

/**
 * §3x.4 (F5) The campaign rule (`conversions/scrub.ts`, the same shape tests as the cloud's ingest), declared here for
 * the type checker only: the runtime ships through `.toString()`, so its source is injected into the runtime's own body
 * (`RUNTIME_SOURCE`), exactly as the conversion helpers carry the scrubber. Nothing at module scope defines it.
 */
declare function infiniteUnsafeCampaign(value: unknown): boolean

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
  return `<script ${RUNTIME_ATTRIBUTE}>;(${RUNTIME_SOURCE})(${serialized});</script>`
}

// The Infinite browser runtime (0.6.0 — the consolidated truth-train release):
//   • emits ONLY to Infinite's same-origin collect route. Mirror mode is GONE: the runtime forwards
//     nothing into PostHog or GA4 and never touches their consent / opt-in / config APIs (the GA4
//     mirror duplicated enhanced-measurement page_views on SPAs). A provider is never reduced WITHOUT
//     a plan line the user approved (decisions 4 and 17). Conversions reach PostHog and GA4 because
//     the SITE'S OWN CODE calls the managed helpers (`infiniteTrack` and friends, decisions 9 and 13),
//     never because this runtime forwards anything. It binds immediately, waiting on nothing;
//   • emits NOTHING when `navigator.webdriver` is true (headless / automation-driven browsers —
//     Lighthouse, Playwright, Puppeteer — are not visitors and must not become page views);
//   • stamps `nav` on every site_page_view: "navigate" for the initial document load, "history"
//     for History-API route changes (pushState / replaceState / popstate). The bounded enum lets the
//     cloud count INITIAL browser page views (the only numerator that can honestly be compared with
//     server document requests) while keeping the pathname-only dedupe exactly as before.
//   • (0.7.0) attaches an ALLOWLISTED campaign block to the nav:"navigate" page view only:
//     utm_source/medium/campaign/content/term as bounded strings, and gclid/fbclid/ttclid/msclkid
//     as PRESENCE booleans (`has_<name>: true`) — never the id value, never the raw query string.
//   The consent contract is UNCHANGED: DNT/GPC suppress by default; the site's explicit decision
//   (the infinite:analytics-consent-change event, gesture-gated) overrides it in either direction;
//   `required` mode stays dormant until granted.
function infiniteBrowserRuntime(config: InfiniteBrowserConfig): void {
  type RuntimeWindow = Window & {
    __infiniteAnalyticsRuntime?: boolean
    __infiniteHandoffContext?: () => InfiniteHandoffContext | null
    __infiniteConsentAllowed?: (options?: { privacySignal?: boolean }) => boolean
  }

  const runtimeWindow = window as RuntimeWindow
  if (runtimeWindow.__infiniteAnalyticsRuntime) return
  runtimeWindow.__infiniteAnalyticsRuntime = true

  // Automation-driven browsers declare themselves (WebDriver spec): never a visit, never an event.
  const underAutomation = (navigator as Navigator & { webdriver?: boolean }).webdriver === true
  // `allowAutomation` is the synthetic/test-sandbox escape hatch (installer-gated to non-production
  // hosts): it lets an automation browser (our own CI / verify harness) be COUNTED so click
  // autocapture can be triggered and verified. Every event a WebDriver session produces is then
  // stamped `automation: true` (see emit) so a non-synthetic cloud ingest can reject/quarantine it.
  // It ALSO lifts the loopback-host exclusion below — a localhost sandbox is the canonical synthetic
  // target — but the production-host allowlist STILL applies, so the runtime only ever emits on a
  // host the source explicitly configured (a localhost sandbox must list "localhost"/"127.0.0.1").
  const allowAutomation = config.allowAutomation === true
  if (underAutomation && !allowAutomation) return

  // The one host normaliser (trim, lowercase, strip ONE trailing dot — `src/host-guard.ts`, §3h.9),
  // inlined because this function ships through `.toString()` and cannot import it: `ACME.com.` is the
  // verified host `acme.com`, never an unverified one.
  const currentHost = location.hostname.trim().toLowerCase().replace(/\.$/, "")
  const isLoopbackHost =
    currentHost === "localhost" ||
    currentHost === "127.0.0.1" ||
    currentHost === "::1" ||
    currentHost === "[::1]"
  const isVerifiedProductionHost =
    config.productionHosts.length > 0 && config.productionHosts.includes(currentHost)
  if ((isLoopbackHost && !allowAutomation) || !isVerifiedProductionHost) return

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

  // `--infinite-autocapture off`: unmarked links and buttons emit nothing. Everything a founder
  // asked for by marking or configuring still emits — data-analytics-cta-id CTAs, the conversion
  // destination, Stripe checkout buckets, data-conversion="checkout|signup", sign-up paths.
  const autocapture = config.autocapture !== false

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

  // Normalize a free-form attribute (an id / aria-label / data-section) into the SAME bounded
  // structural token the runtime uses everywhere else: lowercase, [a-z0-9_-] only, ≤64 chars,
  // regex-validated. Returns null when nothing structural survives — never leaks the raw label.
  function normalizeStructuralToken(raw: string | null | undefined): string | null {
    if (!raw) return null
    const cleaned = raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64)
      .replace(/_+$/g, "")
    return cleaned && structuralTokenPattern.test(cleaned) ? cleaned : null
  }

  // A cta_location derived from the nearest structural region: an explicit data-section wins, then
  // a section id, then an aria-label / role="region" label. Bounded + validated, so a plain
  // <section> that carries any of these no longer collapses to the generic "page".
  function regionLocationToken(region: Element | null): string | null {
    if (!region || typeof (region as { getAttribute?: unknown }).getAttribute !== "function") {
      return null
    }
    const element = region as HTMLElement
    return (
      normalizeStructuralToken(element.getAttribute("data-section")) ??
      normalizeStructuralToken(element.getAttribute("id")) ??
      normalizeStructuralToken(element.getAttribute("aria-label"))
    )
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
    // Before the generic fallback: honor the nearest semantic region (section[id]/[aria-label],
    // role="region", or an explicit data-section) as a bounded structural token.
    const region = regionLocationToken(
      safeClosest(target, 'section[id],section[aria-label],[role="region"],[data-section]')
    )
    if (region) return region
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

  // The campaign allowlist (privacy rules P22/P39): UTM VALUES are bounded strings; click ids are
  // reported as presence only — `has_gclid: true` — so an identifier never enters the ledger. Any
  // other parameter is dropped. Attached ONLY to the initial (nav:"navigate") page view.
  function campaignProperties(search: string): Record<string, string | boolean> {
    const properties: Record<string, string | boolean> = {}
    let params: URLSearchParams
    try {
      params = new URLSearchParams(search)
    } catch {
      return properties
    }
    for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
      const raw = params.get(key)
      if (raw === null) continue
      const value = raw.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 100)
      // §3x.4 (F5): a campaign value that carries an email, a phone-formatted number, a URL or a click id is DROPPED
      // (never rewritten: a half-cleaned value is still a leak). Ad-platform ids (15+ digits) and dates are kept: they
      // are what the campaign is attributed by (review P1-2).
      if (value && !infiniteUnsafeCampaign(raw)) properties[key] = value
    }
    // Optional ad metadata (the door's browser-collect-v1 patterns): a value that does not match its pattern EXACTLY is
    // omitted, never trimmed or cut (a cleaned value could fail the whole view). It also passes the same unsafe-value
    // rule as the UTM fields, so a phone-shaped digit run is dropped while a 15+ digit ad id is kept.
    const adFields: Array<[string, RegExp]> = [
      ["ad_id", /^\d{1,32}$/], ["adset_id", /^\d{1,32}$/], ["campaign_id", /^\d{1,32}$/],
      ["utm_placement", /^[A-Za-z0-9_]{1,64}$/]
    ]
    for (const [key, pattern] of adFields) {
      const value = params.get(key)
      if (value === null) continue
      const match = value.match(pattern)
      if (match && match[0] === value && !infiniteUnsafeCampaign(value)) properties[key] = value
    }
    for (const key of ["gclid", "fbclid", "ttclid", "msclkid"]) {
      const raw = params.get(key)
      if (raw !== null && raw.trim() !== "") properties["has_" + key] = true
    }
    return properties
  }

  function cleanReferrerHost(raw: string): string {
    if (!raw) return ""
    try {
      return new URL(raw, location.href).hostname.toLowerCase().replace(/\.$/, "")
    } catch {
      return ""
    }
  }

  // §3x.4 (F8): the storage is reached INSIDE the try. A browser that blocks storage throws on the `localStorage`
  // getter itself (SecurityError); the visitor then gets page-scoped random ids and is still counted once.
  function storageId(getStorage: () => Storage, key: string): string {
    try {
      const storage = getStorage()
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

  // The runtime's consent check, exposed so the managed helpers (the Meta click-id capture and
  // matching accessor, the conversion helpers, the Meta mirror) follow the SAME decision instead of
  // re-implementing it: the in-memory decision when storage is blocked, the configured storage key in
  // required mode, DNT/GPC as the default. A live check on every call, never a frozen value, and only
  // on a verified production host (the returns above); elsewhere the helpers use their stricter
  // fallback over the persisted decision (`providers/meta-browser/consent.ts`).
  // `{ privacySignal: false }` asks the same question WITHOUT the DNT/GPC default: the conversion
  // helpers that feed GA4/PostHog use it, so a GPC browser's conversions are not dropped while its
  // native page views still count (the recorded decision and required mode still apply).
  runtimeWindow.__infiniteConsentAllowed = (options?: { privacySignal?: boolean }) => {
    if (options && options.privacySignal === false) {
      const decision = consentOverride !== undefined ? consentOverride : storedConsentDecision()
      if (decision !== undefined) return decision
      return config.consent.mode === "not_required"
    }
    return hasConsent()
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
    properties?: Record<string, string | boolean>
  ): void {
    if (!hasConsent()) return
    const canonicalPath = normalizePath(path)
    anonymousId ??= storageId(() => localStorage, "infinite_analytics_visitor")
    sessionId ??= storageId(() => sessionStorage, "infinite_analytics_session")
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
    // Under `allowAutomation`, a WebDriver session's events are counted but marked so a
    // non-synthetic ingest can quarantine them (exact field name `automation`, top-level boolean).
    if (underAutomation) payload.automation = true
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
    emit(
      "site_page_view",
      path,
      nav === "navigate" ? { nav, ...campaignProperties(location.search) } : { nav }
    )
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

      if (!autocapture && !safeClosest(target, "[data-analytics-cta-id]")) return
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
      anonymousId ??= storageId(() => localStorage, "infinite_analytics_visitor")
      sessionId ??= storageId(() => sessionStorage, "infinite_analytics_session")
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

/**
 * The runtime's own source text, exported so the setup checks can DERIVE what `data-conversion`
 * means instead of restating it.
 *
 * The runtime is serialized into the page with `.toString()`, so it cannot import a shared
 * constant — anything it referenced from module scope would be `undefined` in the browser. That
 * rules out the usual "one exported selector both sides use". Reading the source text back is the
 * only seam that cannot drift: change a selector in `bindRuntime` and the checks change with it.
 *
 * A second, independent copy of the rule is exactly how the wrong-element bug survived — the
 * marking step believed `data-conversion` meant "already handled" while the runtime believed it
 * meant two different lanes depending on the tag. Nothing here is a copy.
 */
export const INFINITE_BROWSER_RUNTIME_SOURCE: string = withCampaignRule(infiniteBrowserRuntime.toString())

/** The runtime's source with `infiniteUnsafeCampaign` declared first in its body (hoisted; no closure, no import). */
function withCampaignRule(source: string): string {
  const open = source.indexOf("{")
  if (open < 0) throw new Error("the Infinite runtime source has no body")
  return `${source.slice(0, open + 1)}\n${UNSAFE_CAMPAIGN_SOURCE}\n${source.slice(open + 1)}`
}

/** What the page runs: the runtime with the scrubber inside it. */
const RUNTIME_SOURCE: string = INFINITE_BROWSER_RUNTIME_SOURCE
