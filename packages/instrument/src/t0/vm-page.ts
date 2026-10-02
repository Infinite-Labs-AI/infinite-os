// One T0 page: a `node:vm` context dressed as a browser window (lane O6). Ported and widened from
// infinite-site `.github/scripts/test-inject-analytics.mjs` `executeAnalytics` L904-1147 @ 9f65b47:
// hostname / path / search, DNT / GPC, stored consent, a cookie jar with a write log, local and session
// storage (with a blocked variant), real WebCrypto, `sendBeacon`, inserted script srcs, and
// capture-then-bubble clicks. What it adds is listed in `clock.ts`, `recorders.ts`, `stubs.ts` and
// `dom.ts`; here those pieces are assembled into a window, the page's scripts run in document order, and
// every navigation is recorded and CANCELLED (the page stays, exactly as the desktop's dry modes do).
//
// THIS RUNS ONLY INSIDE THE SANDBOXED CHILD (`child.ts`). `node:vm` is not a security boundary: page code
// can reach the host through any host object's constructor. Never construct a T0Page in the wizard's
// own process (`run.ts` spawns the child; a test asserts the pid differs).
import { randomUUID, webcrypto } from "node:crypto"
import { createContext, runInContext, type Context } from "node:vm"

import type { VirtualClock } from "./clock.js"
import type { CookieJar } from "./cookie-jar.js"
import { T0CustomEvent, T0Document, T0Element, T0Event, T0EventTarget, T0Text, parseMarkupInto } from "./dom.js"
import type { T0LoadAction, T0LoaderBehaviour, T0PosthogInit, T0ResponseRule, T0SessionRecording } from "./protocol.js"
import { T0_SILENCED_FBQ, T0_WATCHED_GLOBALS } from "./protocol.js"
import { bodyText, createFetch, createSendBeacon, createXhrClass, type RecorderEnv, type T0Recorder } from "./recorders.js"
import { classifyLoader, loadFbeventsStub, loadGtagStub, loadPosthogStub, type StubHost } from "./stubs.js"

/** State that outlives one page: one throwaway browser profile. */
export interface T0SessionState {
  jar: CookieJar
  local: Map<string, string>
  session: Map<string, string>
  clock: VirtualClock
  recorder: T0Recorder
  posthogInits: T0PosthogInit[]
  metaPixels: string[]
  ga4Configs: string[]
  storageWrites: T0SessionRecording["storageWrites"]
}

const SCRIPT_TIMEOUT_MS = 2_000

function storageApi(map: Map<string, string>, blocked: boolean, onWrite: (key: string, value: string) => void): Record<string, unknown> {
  const deny = () => {
    throw new Error("SecurityError: The operation is insecure.")
  }
  return {
    getItem: (key: unknown) => (blocked ? deny() : (map.get(String(key)) ?? null)),
    setItem: (key: unknown, value: unknown) => {
      if (blocked) return deny()
      map.set(String(key), String(value))
      onWrite(String(key), String(value))
    },
    removeItem: (key: unknown) => (blocked ? deny() : void map.delete(String(key))),
    clear: () => (blocked ? deny() : map.clear()),
    key: (index: number) => (blocked ? deny() : ([...map.keys()][index] ?? null)),
    get length() {
      return blocked ? deny() : map.size
    }
  }
}

function isJavaScriptType(type: string | null): boolean {
  if (type === null || type === "") return true
  return /^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/i.test(type.trim())
}

export class T0Page {
  readonly url: URL
  readonly document: T0Document
  readonly context: Context
  readonly window: Record<string, unknown>
  private readonly winTarget = new T0EventTarget()
  private readonly historyListeners: Array<() => void> = []
  readonly scriptErrors: string[] = []
  /** Pixel ids / GA4 ids registered on THIS page (the session keeps the union). */
  readonly metaPixels: string[] = []
  readonly ga4Configs: string[] = []
  private readonly rules: readonly T0ResponseRule[]
  private readonly loaders: T0LoaderBehaviour
  private currentUrl: URL
  /** The page's URL resolver, held here (not read back from the page-visible document, review O6-R6). */
  private readonly resolve: (raw: string) => string

  constructor(
    private readonly state: T0SessionState,
    private readonly spec: T0LoadAction
  ) {
    this.url = new URL(spec.url)
    this.currentUrl = new URL(spec.url)
    this.rules = spec.responses ?? []
    this.loaders = spec.loaders ?? {}
    state.jar.hostname = this.url.hostname
    const resolveUrl = (raw: string) => {
      try {
        return new URL(raw, this.currentUrl.href).href
      } catch {
        return String(raw)
      }
    }
    this.resolve = resolveUrl
    this.document = new T0Document(
      {
        onScriptConnected: (node) => this.scriptConnected(node),
        onImageSrc: (node, src) => this.imageRequest(node, src),
        onAnchorActivation: (anchor, event) => this.anchorActivation(anchor, event),
        onFormSubmission: (form) => this.formSubmission(form)
      },
      resolveUrl
    )
    this.document.windowTarget = this.winTarget
    this.document.reportError = (error) => this.reportError(error)
    this.document.referrer = spec.referrer ?? ""
    const jar = state.jar
    const cookiesBlocked = spec.cookiesBlocked === true
    Object.defineProperty(this.document, "cookie", {
      configurable: true,
      get: () => (cookiesBlocked ? "" : jar.read()),
      set: (value: unknown) => {
        if (cookiesBlocked) return
        jar.write(String(value))
      }
    })
    const page = this
    const location = this.locationObject()
    Object.defineProperty(this.document, "location", { configurable: true, get: () => location, set: (value: unknown) => page.navigate(String(value), "location") })

    const env: RecorderEnv = {
      recorder: state.recorder,
      clock: state.clock,
      rules: this.rules,
      resolveUrl,
      beaconRefuses: this.loaders.beaconRefuses === true,
      onImageRequest: () => undefined
    }
    const clock = state.clock
    const ImageClass = function (this: unknown) {
      return page.document.createElement("img")
    } as unknown as new () => T0Element
    const sandbox: Record<string, unknown> = {
      document: this.document,
      navigator: {
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        language: "en-US",
        languages: ["en-US", "en"],
        platform: "MacIntel",
        vendor: "Google Inc.",
        cookieEnabled: !cookiesBlocked,
        onLine: true,
        webdriver: spec.webdriver === true,
        doNotTrack: spec.doNotTrack ?? null,
        globalPrivacyControl: spec.globalPrivacyControl === true,
        sendBeacon: createSendBeacon(env),
        userAgentData: { mobile: false, platform: "macOS", brands: [] }
      },
      history: this.historyObject(),
      screen: { width: 1512, height: 982, availWidth: 1512, availHeight: 982, colorDepth: 30 },
      innerWidth: 1280,
      innerHeight: 800,
      outerWidth: 1280,
      outerHeight: 800,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 0,
      pageXOffset: 0,
      pageYOffset: 0,
      name: "",
      origin: this.url.origin,
      isSecureContext: this.url.protocol === "https:",
      fetch: createFetch(env),
      XMLHttpRequest: createXhrClass(env),
      Image: ImageClass,
      setTimeout: (fn: unknown, delay?: unknown) => clock.setTimeout(fn, delay),
      clearTimeout: (id: unknown) => clock.clearTimeout(id),
      setInterval: (fn: unknown, delay?: unknown) => clock.setTimeout(fn, delay, true),
      clearInterval: (id: unknown) => clock.clearTimeout(id),
      requestAnimationFrame: (fn: unknown) => clock.setTimeout(typeof fn === "function" ? () => (fn as (t: number) => void)(clock.elapsed) : fn, 16),
      cancelAnimationFrame: (id: unknown) => clock.clearTimeout(id),
      requestIdleCallback: (fn: unknown) => clock.setTimeout(typeof fn === "function" ? () => (fn as (d: unknown) => void)({ didTimeout: false, timeRemaining: () => 50 }) : fn, 1),
      cancelIdleCallback: (id: unknown) => clock.clearTimeout(id),
      queueMicrotask: (fn: () => void) => queueMicrotask(() => {
        try {
          fn()
        } catch (error) {
          page.reportError(error)
        }
      }),
      Date: clock.dateClass(),
      performance: clock.performance(),
      PerformanceObserver: clock.performanceObserverClass(),
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      AbortController,
      Blob: class {
        __t0Text: string
        size: number
        type: string
        constructor(parts: unknown[] = [], options: { type?: string } = {}) {
          this.__t0Text = parts.map((part) => (typeof part === "string" ? part : (bodyText(part) ?? ""))).join("")
          this.size = this.__t0Text.length
          this.type = options.type ?? ""
        }
      },
      FormData: class {
        private entries: Array<[string, string]> = []
        constructor() {}
        append(key: string, value: unknown): void {
          this.entries.push([String(key), String(value)])
        }
        get __t0Text(): string {
          return new URLSearchParams(this.entries).toString()
        }
      },
      atob: (value: string) => Buffer.from(String(value), "base64").toString("binary"),
      btoa: (value: string) => Buffer.from(String(value), "binary").toString("base64"),
      crypto: {
        randomUUID,
        getRandomValues: <T extends ArrayBufferView>(array: T) => webcrypto.getRandomValues(array as unknown as Uint8Array) as unknown as T,
        subtle: webcrypto.subtle
      },
      structuredClone: (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown,
      matchMedia: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      scrollTo() {},
      scroll() {},
      open: (url: unknown) => {
        page.navigate(String(url ?? ""), "window.open")
        return null
      },
      close() {},
      focus() {},
      alert() {},
      confirm: () => false,
      prompt: () => null,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {}, trace() {} },
      Event: T0Event,
      CustomEvent: T0CustomEvent,
      MouseEvent: T0Event,
      KeyboardEvent: T0Event,
      PointerEvent: T0Event,
      FocusEvent: T0Event,
      Node: T0Element,
      Element: T0Element,
      HTMLElement: T0Element,
      HTMLAnchorElement: T0Element,
      HTMLFormElement: T0Element,
      HTMLScriptElement: T0Element,
      Text: T0Text,
      EventTarget: T0EventTarget,
      addEventListener: (type: string, fn: unknown, options?: boolean | { capture?: boolean; once?: boolean }) => this.winTarget.addEventListener(type, fn, options),
      removeEventListener: (type: string, fn: unknown, options?: boolean | { capture?: boolean }) => this.winTarget.removeEventListener(type, fn, options),
      dispatchEvent: (event: T0Event) => {
        event.target = page.window
        page.winTarget.invoke(event, "target", (error) => page.reportError(error))
        return !event.defaultPrevented
      }
    }
    const logWrite = (area: "local" | "session") => (key: string, value: string) => {
      if (state.storageWrites.length < 500) state.storageWrites.push({ action: state.recorder.action, area, key, value: value.slice(0, 2048) })
    }
    const localStore = storageApi(state.local, spec.storageBlocked === true, logWrite("local"))
    const sessionStore = storageApi(state.session, spec.storageBlocked === true, logWrite("session"))
    const blockedGetter = (store: Record<string, unknown>) => () => {
      if (spec.storageBlocked === true) throw new Error("SecurityError: The operation is insecure.")
      return store
    }
    Object.defineProperty(sandbox, "localStorage", { configurable: true, enumerable: true, get: blockedGetter(localStore) })
    Object.defineProperty(sandbox, "sessionStorage", { configurable: true, enumerable: true, get: blockedGetter(sessionStore) })
    Object.defineProperty(sandbox, "location", {
      configurable: true,
      enumerable: true,
      get: () => location,
      set: (value: unknown) => page.navigate(String(value), "location")
    })
    this.context = createContext(sandbox, { name: `t0:${this.url.host}`, codeGeneration: { strings: true, wasm: false } })
    const global = runInContext("this", this.context) as Record<string, unknown>
    for (const alias of ["window", "self", "top", "parent", "frames"]) sandbox[alias] = global
    this.window = global
  }

  private locationObject(): Record<string, unknown> {
    const page = this
    const location: Record<string, unknown> = {
      assign: (url: unknown) => page.navigate(String(url), "location.assign"),
      replace: (url: unknown) => page.navigate(String(url), "location.replace"),
      reload: () => page.navigate(page.currentUrl.href, "location.reload"),
      toString: () => page.currentUrl.href
    }
    for (const key of ["origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"] as const) {
      Object.defineProperty(location, key, { enumerable: true, get: () => page.currentUrl[key] })
    }
    Object.defineProperty(location, "href", {
      enumerable: true,
      get: () => page.currentUrl.href,
      set: (value: unknown) => page.navigate(String(value), "location.href")
    })
    return location
  }

  private historyObject(): Record<string, unknown> {
    const page = this
    let historyState: unknown = null
    const change = (method: string) => (state: unknown, _title: unknown, url?: unknown) => {
      historyState = state
      if (url !== undefined && url !== null) {
        const next = new URL(String(url), page.currentUrl.href)
        if (next.origin !== page.currentUrl.origin) throw new Error(`SecurityError: ${method} to another origin`)
        const changed = next.href !== page.currentUrl.href
        page.currentUrl = next
        if (changed) for (const listener of page.historyListeners) listener()
      }
    }
    return {
      length: 1,
      scrollRestoration: "auto",
      get state() {
        return historyState
      },
      pushState: change("pushState"),
      replaceState: change("replaceState"),
      back() {},
      forward() {},
      go() {}
    }
  }

  get href(): string {
    return this.currentUrl.href
  }

  reportError(error: unknown): void {
    this.scriptErrors.push(error instanceof Error ? error.message : String(error))
  }

  /** A top-level navigation: recorded and cancelled. The page stays. */
  navigate(raw: string, _via: string): void {
    let url: string
    try {
      url = new URL(raw, this.currentUrl.href).href
    } catch {
      url = raw
    }
    if (url.startsWith("javascript:")) return
    this.state.recorder.record("navigation", "GET", url, null)
  }

  private stubHost(): StubHost {
    const page = this
    const state = this.state
    return {
      window: this.window,
      href: () => page.currentUrl.href,
      path: () => page.currentUrl.pathname,
      recorder: state.recorder,
      clock: state.clock,
      loaders: this.loaders,
      posthogInits: state.posthogInits,
      metaPixels: this.metaPixels,
      ga4Configs: this.ga4Configs,
      sendImage: (url, origin, delay) => {
        const request = state.recorder.record("image", "GET", url, null, origin)
        if (delay === "never") return
        state.clock.setTimeout(() => state.clock.reportResource(url, "img", request.at), delay)
      },
      sendBeacon: (url, body, origin) => void state.recorder.record("beacon", "POST", url, body, origin),
      sendFetch: (url, method, body, origin) => void state.recorder.record("fetch", method, url, body, origin),
      onHistoryChange: (listener) => page.historyListeners.push(listener),
      reportError: (error) => page.reportError(error)
    }
  }

  private runCode(code: string, label: string): void {
    try {
      runInContext(code, this.context, { filename: label, timeout: SCRIPT_TIMEOUT_MS })
    } catch (error) {
      this.reportError(error)
    }
  }

  private fireLoad(node: T0Element): void {
    const handler = (node as unknown as { onload?: unknown }).onload
    const event = new T0Event("load")
    event.target = node
    if (typeof handler === "function") {
      try {
        ;(handler as (event: T0Event) => void).call(node, event)
      } catch (error) {
        this.reportError(error)
      }
    }
    node.invoke(event, "target", (error) => this.reportError(error))
  }

  /** A script element was connected (parsed scripts are run by `load()`, not here). */
  private scriptConnected(node: T0Element): void {
    if (!isJavaScriptType(node.getAttribute("type"))) return
    const src = node.getAttribute("src")
    if (!src) {
      this.runCode(node.textContent, `inline-script@${this.currentUrl.pathname}`)
      return
    }
    this.loadExternalScript(node, this.resolve(src), false)
  }

  private loadExternalScript(node: T0Element | null, url: string, synchronous: boolean): void {
    this.state.recorder.record("script", "GET", url, null)
    const delay = this.loaders.loadDelayMs ?? 10
    const loader = classifyLoader(url)
    const host = () => this.stubHost()
    const finish = (run: () => void) => {
      run()
      if (node) this.fireLoad(node)
    }
    if (loader === "gtag") {
      if (this.loaders.gtag === "blocked") return
      this.state.clock.setTimeout(() => finish(() => loadGtagStub(host())), delay)
      return
    }
    if (loader === "fbevents") {
      if (this.loaders.fbevents === "blocked") return
      this.state.clock.setTimeout(() => finish(() => loadFbeventsStub(host())), delay)
      return
    }
    if (loader === "posthog") {
      if (this.loaders.posthog === "blocked") return
      this.state.clock.setTimeout(() => finish(() => loadPosthogStub(host())), delay)
      return
    }
    if (loader !== null) return
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return
    }
    if (parsed.origin !== this.url.origin) return
    const body = this.spec.source.resources?.[parsed.pathname]
    if (body === undefined) return
    if (synchronous) {
      this.runCode(body, parsed.pathname)
      if (node) this.fireLoad(node)
    } else this.state.clock.setTimeout(() => finish(() => this.runCode(body, parsed.pathname)), delay)
  }

  private imageRequest(_node: T0Element, src: string): void {
    const request = this.state.recorder.record("image", "GET", src, null)
    const isTr = /^https:\/\/([a-z0-9-]+\.)*facebook\.com\/tr\/?(?:[?#]|$)/i.test(src)
    const delay = isTr ? (this.loaders.metaTrDelayMs ?? 30) : 20
    if (delay === "never") return
    this.state.clock.setTimeout(() => {
      this.state.clock.reportResource(src, "img", request.at)
      this.fireLoad(_node)
    }, delay)
  }

  private anchorActivation(anchor: T0Element, event: T0Event): void {
    const target = (anchor.getAttribute("target") ?? "").toLowerCase()
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    const href = anchor.getAttribute("href")
    if (href === null || href.startsWith("#")) return
    if (target === "_blank") {
      this.navigate(href, "anchor-new-tab")
      return
    }
    this.navigate(href, "anchor")
  }

  private formSubmission(form: T0Element): void {
    const method = (form.getAttribute("method") ?? "GET").toUpperCase()
    const action = form.getAttribute("action") ?? this.currentUrl.href
    const url = this.resolve(action)
    const fields = form
      .querySelectorAll("input, select, textarea")
      .filter((input) => input.getAttribute("name"))
      .map((input) => [input.getAttribute("name")!, input.getAttribute("value") ?? ""] as [string, string])
    const body = new URLSearchParams(fields).toString()
    this.state.recorder.record("form", method, url, method === "GET" ? null : body)
    this.state.recorder.mark("navigate", ["form", url])
  }

  /** Parse the HTML, run its scripts in document order, fire DOMContentLoaded and load, then settle. */
  async load(): Promise<void> {
    const source = this.spec.source
    if (source.html) parseMarkupInto(this.document.body, source.html)
    const parsedScripts = this.document.querySelectorAll("script")
    for (const node of parsedScripts) {
      if (!isJavaScriptType(node.getAttribute("type"))) {
        const src = node.getAttribute("src")
        if (src && /module/i.test(node.getAttribute("type") ?? "")) this.state.recorder.record("script", "GET", this.resolve(src), null)
        continue
      }
      const src = node.getAttribute("src")
      if (src) {
        const sync = !node.hasAttribute("async") && !node.hasAttribute("defer")
        this.loadExternalScript(node, this.resolve(src), sync)
      } else this.runCode(node.textContent, `${this.url.pathname}#script`)
    }
    for (const script of source.scripts ?? []) this.runCode(script.code, script.label)
    this.document.readyState = "interactive"
    this.document.dispatchEvent(new T0Event("DOMContentLoaded", { bubbles: true }))
    this.document.readyState = "complete"
    const loadEvent = new T0Event("load")
    loadEvent.target = this.window
    this.winTarget.invoke(loadEvent, "target", (error) => this.reportError(error))
    await this.state.clock.advance(this.spec.settleMs ?? 1500)
  }

  /** Click the first element matching `selector` (pointerdown, mousedown, mouseup, click). */
  async click(selector: string, settleMs: number): Promise<boolean> {
    const element = this.document.querySelector(selector)
    if (!element) return false
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
      this.document.dispatch(element, new T0Event(type, { bubbles: true, cancelable: true }))
    }
    element.click()
    await this.state.clock.advance(settleMs)
    return true
  }

  /** Evaluate an expression in the page; a returned promise is awaited while virtual time runs. */
  async evaluate(expression: string, settleMs: number): Promise<unknown> {
    let value: unknown
    try {
      value = runInContext(expression, this.context, { filename: "t0-eval", timeout: SCRIPT_TIMEOUT_MS })
    } catch (error) {
      this.reportError(error)
      return { error: error instanceof Error ? error.message : String(error) }
    }
    let settled: { value: unknown } | null = null
    if (value && typeof (value as { then?: unknown }).then === "function") {
      ;(value as Promise<unknown>).then(
        (resolved) => {
          settled = { value: resolved }
        },
        (error: unknown) => {
          settled = { value: { error: error instanceof Error ? error.message : String(error) } }
        }
      )
      await this.state.clock.advance(settleMs)
      return settled === null ? { pending: true } : (settled as { value: unknown }).value
    }
    await this.state.clock.advance(settleMs)
    return value
  }

  async spaNavigate(path: string, settleMs: number): Promise<void> {
    const history = this.window.history as { pushState(state: unknown, title: string, url: string): void }
    try {
      history.pushState({}, "", path)
    } catch (error) {
      this.reportError(error)
    }
    await this.state.clock.advance(settleMs)
  }

  /** Which watched analytics globals are defined now. */
  definedGlobals(): string[] {
    const defined: string[] = T0_WATCHED_GLOBALS.filter((name) => {
      try {
        return this.window[name] !== undefined && this.window[name] !== null
      } catch {
        return false
      }
    })
    try {
      const fbq = this.window.fbq as { __infiniteSilenced?: unknown } | undefined
      if (typeof fbq === "function" && (fbq as { __infiniteSilenced?: unknown }).__infiniteSilenced === true) defined.push(T0_SILENCED_FBQ)
    } catch {
      // An fbq getter that throws is not the silenced stand-in.
    }
    return defined
  }
}
