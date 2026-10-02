// Stand-ins for the three vendor libraries a T0 page loads (lane O6): Google's `gtag/js`, PostHog's
// `array.js` and Meta's `fbevents.js`. The page's OWN bytes (the snippet infinite-tag emitted, or the
// customer's adopted snippet) run for real; when they insert the vendor loader, T0 does not fetch it —
// it runs one of these instead, which turns the queued calls into the beacons the real library would
// send (all recorded, all cancelled). They model what grading needs and nothing else:
//   • gtag: `config` → one `page_view` per id unless `send_page_view:false`; `event` → one beacon per
//     configured id (or `send_to`); `event_callback` fires after a delay, never, or twice (scenario
//     choice); enhanced measurement's history page views on pushState/replaceState.
//   • PostHog: each `init` is recorded with its options and the page path (D17), boots `/flags`, sends
//     `$pageview` unless `capture_pageview:false`, then replays the stub's queued calls.
//   • fbevents: `init` registers a pixel; `track` / `trackSingle` / `trackCustom` become one `/tr`
//     image request per pixel carrying `ev` and `eid`; the request "completes" after its delay, which
//     is when a PerformanceObserver hears about it (the mirror's 400 ms wait listens for exactly that).
// None of them sends a cookie value anywhere (the fake-click-id check would otherwise trip on Meta's own,
// legitimate `fbc` parameter).
import type { VirtualClock } from "./clock.js"
import type { T0LoaderBehaviour, T0PosthogInit, T0Request } from "./protocol.js"
import { jsonSafe, type T0Recorder } from "./recorders.js"

export type LoaderKind = "gtag" | "gtm" | "fbevents" | "posthog" | "x"

/** Which vendor loader a script URL is (null = not a known loader). */
export function classifyLoader(url: string): LoaderKind | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const host = parsed.hostname
  const path = parsed.pathname
  if ((host === "www.googletagmanager.com" || host === "googletagmanager.com") && path === "/gtag/js") return "gtag"
  if ((host === "www.googletagmanager.com" || host === "googletagmanager.com") && path === "/gtm.js") return "gtm"
  if (host === "connect.facebook.net" && path.endsWith("/fbevents.js")) return "fbevents"
  if (path.endsWith("/static/array.js") || /\/array\/[^/]+\/config(?:\.js)?$/.test(path)) return "posthog"
  if (host === "static.ads-twitter.com" && path.endsWith("/uwt.js")) return "x"
  return null
}

export interface StubHost {
  window: Record<string, unknown>
  href(): string
  path(): string
  recorder: T0Recorder
  clock: VirtualClock
  loaders: T0LoaderBehaviour
  posthogInits: T0PosthogInit[]
  metaPixels: string[]
  ga4Configs: string[]
  /** Records an image GET; `complete` runs when it finishes (after `delay`, or never). */
  sendImage(url: string, origin: T0Request["origin"], delay: number | "never"): void
  sendBeacon(url: string, body: string | null, origin: T0Request["origin"]): void
  sendFetch(url: string, method: string, body: string | null, origin: T0Request["origin"]): void
  onHistoryChange(listener: () => void): void
  reportError(error: unknown): void
}

function args(value: unknown): unknown[] {
  if (value && typeof value === "object" && "length" in (value as object)) return Array.from(value as ArrayLike<unknown>)
  return []
}

function scalarParams(params: unknown, prefix: string): string {
  if (!params || typeof params !== "object") return ""
  const out: string[] = []
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (key === "event_callback" || key === "event_timeout" || key === "send_to") continue
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      out.push(`${prefix}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return out.length ? `&${out.join("&")}` : ""
}

// ---- GA4 ---------------------------------------------------------------------------------------

export function loadGtagStub(host: StubHost): void {
  const win = host.window
  const layer = (Array.isArray(win.dataLayer) ? win.dataLayer : (win.dataLayer = [])) as unknown[]
  if ((layer as { __t0Gtag?: boolean }).__t0Gtag) return
  ;(layer as { __t0Gtag?: boolean }).__t0Gtag = true
  const configs: Array<{ id: string; pageView: boolean }> = []
  const beacon = (id: string, eventName: string, params: unknown) => {
    const url = `https://region1.google-analytics.com/g/collect?v=2&tid=${encodeURIComponent(id)}&en=${encodeURIComponent(eventName)}&dl=${encodeURIComponent(host.href())}${scalarParams(params, "ep.")}`
    host.sendBeacon(url, null, "stub:ga4")
  }
  const process = (entry: unknown, queued: boolean) => {
    const call = args(entry)
    const command = call[0]
    if (typeof command !== "string") return
    host.recorder.mark("gtag", call, queued)
    if (command === "config" && typeof call[1] === "string") {
      const id = call[1]
      const params = call[2] as Record<string, unknown> | undefined
      const pageView = !(params && params.send_page_view === false)
      if (!configs.some((config) => config.id === id)) {
        configs.push({ id, pageView })
        host.ga4Configs.push(id)
      }
      if (pageView && /^G-/.test(id)) beacon(id, "page_view", params)
      return
    }
    if (command === "event" && typeof call[1] === "string") {
      const name = call[1]
      const params = (call[2] ?? {}) as Record<string, unknown>
      const sendTo = params.send_to
      const targets =
        typeof sendTo === "string" ? [sendTo] : Array.isArray(sendTo) ? sendTo.map(String) : configs.map((config) => config.id)
      for (const id of targets) if (/^G-/.test(id)) beacon(id, name, params)
      const callback = params.event_callback
      if (typeof callback === "function") {
        const mode = host.loaders.ga4EventCallback ?? "fires"
        const delay = host.loaders.ga4EventCallbackDelayMs ?? 50
        const fire = () => {
          try {
            ;(callback as () => void)()
          } catch (error) {
            host.reportError(error)
          }
        }
        if (mode !== "never") host.clock.setTimeout(fire, delay)
        if (mode === "twice") host.clock.setTimeout(fire, delay + 10)
      }
    }
  }
  for (const entry of [...layer]) process(entry, true)
  const push = layer.push.bind(layer)
  layer.push = (...items: unknown[]) => {
    for (const item of items) process(item, false)
    return push(...items)
  }
  // Enhanced measurement's "page changes based on browser history events" (on by default).
  host.onHistoryChange(() => {
    for (const config of configs) if (config.pageView && /^G-/.test(config.id)) beacon(config.id, "page_view", undefined)
  })
}

// ---- PostHog -----------------------------------------------------------------------------------

export function loadPosthogStub(host: StubHost): void {
  const win = host.window
  const stub = win.posthog as (unknown[] & { _i?: unknown[]; __loaded?: boolean; __SV?: number }) | undefined
  if (!stub || (stub as { __t0Real?: boolean }).__t0Real) return
  const inits = Array.isArray(stub._i) ? [...stub._i] : []
  const queued = Array.isArray(stub) ? [...stub] : []
  let projectKey = ""
  let apiHost = ""
  let distinctId = `t0-${host.clock.now().toString(36)}`
  const send = (event: string, properties: Record<string, unknown> = {}) => {
    if (!apiHost || !projectKey) return
    const body = JSON.stringify({ api_key: projectKey, event, properties: { distinct_id: distinctId, $current_url: host.href(), $pathname: host.path(), ...properties } })
    host.sendFetch(`${apiHost.replace(/\/$/, "")}/e/`, "POST", body, "stub:posthog")
  }
  let captureHistory = false
  const real: Record<string, unknown> = {
    __t0Real: true,
    __loaded: true,
    init(key: unknown, options: unknown) {
      const opts = (options && typeof options === "object" ? options : {}) as Record<string, unknown>
      projectKey = String(key)
      apiHost = typeof opts.api_host === "string" ? new URL(opts.api_host, host.href()).href : "https://us.i.posthog.com"
      host.posthogInits.push({ projectKey, options: jsonSafe(opts) as Record<string, unknown>, path: host.path(), action: host.recorder.action })
      host.recorder.mark("posthog", ["init", key, opts])
      host.sendFetch(`${apiHost.replace(/\/$/, "")}/flags/?v=2`, "POST", JSON.stringify({ token: projectKey, distinct_id: distinctId }), "stub:posthog")
      const pageview = opts.capture_pageview
      captureHistory = pageview === "history_change" || (pageview === undefined && typeof opts.defaults === "string")
      if (pageview !== false) send("$pageview")
    },
    capture(event: unknown, properties?: unknown) {
      host.recorder.mark("posthog", ["capture", event, properties])
      send(String(event), (properties && typeof properties === "object" ? properties : {}) as Record<string, unknown>)
    },
    identify(id: unknown) {
      host.recorder.mark("posthog", ["identify", id])
      const previous = distinctId
      distinctId = String(id)
      send("$identify", { $anon_distinct_id: previous })
    },
    reset() {
      host.recorder.mark("posthog", ["reset"])
      distinctId = `t0-reset-${host.clock.now().toString(36)}`
    },
    get_distinct_id: () => distinctId,
    register() {},
    register_once() {},
    unregister() {},
    set_config(config: unknown) {
      host.recorder.mark("posthog", ["set_config", config])
    },
    startSessionRecording() {
      host.recorder.mark("posthog", ["startSessionRecording"])
    },
    stopSessionRecording() {
      host.recorder.mark("posthog", ["stopSessionRecording"])
    },
    opt_in_capturing() {},
    opt_out_capturing() {},
    has_opted_out_capturing: () => false,
    onFeatureFlags() {},
    isFeatureEnabled: () => false,
    getFeatureFlag: () => undefined,
    people: { set() {} }
  }
  win.posthog = real
  for (const init of inits) {
    const call = args(init)
    ;(real.init as (key: unknown, options: unknown) => void)(call[0], call[1])
  }
  for (const entry of queued) {
    const call = args(entry)
    const method = call[0]
    if (typeof method === "string" && typeof real[method] === "function") {
      try {
        ;(real[method] as (...rest: unknown[]) => void)(...call.slice(1))
      } catch (error) {
        host.reportError(error)
      }
    }
  }
  host.onHistoryChange(() => {
    if (captureHistory) send("$pageview")
  })
}

// ---- Meta --------------------------------------------------------------------------------------

export function loadFbeventsStub(host: StubHost): void {
  const win = host.window
  const fbq = win.fbq as ((...rest: unknown[]) => void) & { queue?: unknown[]; callMethod?: unknown; __t0Loaded?: boolean }
  if (typeof fbq !== "function" || fbq.__t0Loaded) return
  fbq.__t0Loaded = true
  const tr = (pixelId: string, ev: string, data: unknown, options: unknown) => {
    const eid = options && typeof options === "object" && typeof (options as { eventID?: unknown }).eventID === "string" ? (options as { eventID: string }).eventID : ""
    const url = `https://www.facebook.com/tr/?id=${encodeURIComponent(pixelId)}&ev=${encodeURIComponent(ev)}&dl=${encodeURIComponent(host.href())}&eid=${encodeURIComponent(eid)}${scalarParams(data, "cd.")}`
    host.sendImage(url, "stub:meta", host.loaders.metaTrDelayMs ?? 30)
  }
  const handle = (call: unknown[], queued: boolean) => {
    host.recorder.mark("fbq", call, queued)
    const [method, a, b, c, d] = call
    if (method === "init" && typeof a === "string") {
      if (!host.metaPixels.includes(a)) host.metaPixels.push(a)
      return
    }
    if (method === "track" && typeof a === "string") {
      for (const pixel of host.metaPixels) tr(pixel, a, b, c)
      return
    }
    if (method === "trackCustom" && typeof a === "string") {
      for (const pixel of host.metaPixels) tr(pixel, a, b, c)
      return
    }
    if ((method === "trackSingle" || method === "trackSingleCustom") && typeof a === "string" && typeof b === "string") {
      tr(a, b, c, d)
    }
  }
  fbq.callMethod = (...call: unknown[]) => handle(call, false)
  const queue = Array.isArray(fbq.queue) ? [...fbq.queue] : []
  fbq.queue = []
  for (const entry of queue) handle(args(entry), true)
}
