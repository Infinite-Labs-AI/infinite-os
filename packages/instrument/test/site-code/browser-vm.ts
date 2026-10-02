// A small browser for running the bytes infinite-tag writes into customer sites, in node:vm.
//
// Test helper only (outside `src/`, so it is never built or packed). It exists because the site-code
// rules are about ORDER and TIMING — a navigation that outruns its own pixel call, a callback that
// fires twice, a budget that releases at 400 ms and not before — and a grep can prove none of that.
//
// What it models, and why:
//   - `window` IS the global object, as in a browser, so `var` at script top level and `window.x` are
//     the same thing, and an inline script that throws is REPORTED (scriptErrors), never propagated to
//     the code that appended it.
//   - A VIRTUAL CLOCK. `setTimeout` queues; nothing runs until the test advances time, so a race can be
//     expressed (infinite.fast's T0 flushed every timer synchronously and could not).
//   - A cookie jar faithful to RFC 6265bis where it decides which cookie a page reads (ported from
//     infinite-site `.github/scripts/fixtures/browser-cookie-jar.mjs` @ 9f65b47, as `click-id.test.ts`
//     ported it): host-only vs Domain cookies, oldest first, and a Domain attribute on a public suffix
//     (`vercel.app`, `co.uk`) refused.
//   - Every network surface RECORDS and goes nowhere: inserted script srcs, `fetch`, `sendBeacon`.
//   - A fake PerformanceObserver the test drives with `resourceLoaded(url)`.
import { runInContext, createContext, type Context } from "node:vm"
import { webcrypto } from "node:crypto"

const PUBLIC_SUFFIXES = new Set([
  "app",
  "vercel.app",
  "netlify.app",
  "dev",
  "pages.dev",
  "io",
  "github.io",
  "fast",
  "com",
  "co.uk",
  "uk",
  "example",
  "local",
  "localhost"
])

const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

interface StoredCookie {
  name: string
  value: string
  domain: string
  hostOnly: boolean
  created: number
}

export interface CookieJar {
  writes: string[]
  read(): string
  write(written: string): void
  values(name: string): string[]
}

export function createCookieJar(hostname: string, initial: string[] = []): CookieJar {
  const store: StoredCookie[] = []
  let created = 0
  const host = hostname.toLowerCase().replace(/\.$/, "")
  function write(written: string): void {
    const [pair = "", ...attributes] = String(written).split(";")
    const separator = pair.indexOf("=")
    if (separator === -1) return
    const name = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1)
    let domain: string | null = null
    let maxAge: number | null = null
    for (const attribute of attributes) {
      const at = attribute.indexOf("=")
      const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase()
      const raw = at === -1 ? "" : attribute.slice(at + 1).trim()
      if (key === "domain") domain = raw.replace(/^\./, "").toLowerCase()
      if (key === "max-age") maxAge = Number(raw)
    }
    let hostOnly = true
    if (domain !== null) {
      if (PUBLIC_SUFFIXES.has(domain) && domain !== host) return
      if (!domainMatches(host, domain)) return
      hostOnly = domain === host && PUBLIC_SUFFIXES.has(domain)
    } else {
      domain = host
    }
    const index = store.findIndex(
      (cookie) => cookie.name === name && cookie.domain === domain && cookie.hostOnly === hostOnly
    )
    if (maxAge !== null && maxAge <= 0) {
      if (index !== -1) store.splice(index, 1)
      return
    }
    if (index !== -1) {
      store[index]!.value = value
      return
    }
    store.push({ name, value, domain, hostOnly, created: created++ })
  }
  const visible = () =>
    store
      .filter((cookie) => (cookie.hostOnly ? cookie.domain === host : domainMatches(host, cookie.domain)))
      .sort((a, b) => a.created - b.created)
  const jar: CookieJar = {
    writes: [],
    read: () => visible().map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    write: (written) => {
      jar.writes.push(String(written))
      write(written)
    },
    values: (name) => visible().filter((cookie) => cookie.name === name).map((cookie) => cookie.value)
  }
  for (const cookie of initial) write(cookie)
  return jar
}

export interface BrowserVmOptions {
  /** The page URL. Default `https://acme.com/`. */
  url?: string
  referrer?: string
  userAgent?: string
  localStorage?: Record<string, string>
  sessionStorage?: Map<string, string>
  /** Initial cookies, each as a `document.cookie` write (`name=value;domain=…`). */
  cookies?: string[]
  dnt?: string
  gpc?: boolean
  storageThrows?: boolean
  cookieThrows?: boolean
  /** Default true. `false` models an old browser without PerformanceObserver. */
  performanceObserver?: boolean
  /** Start time of the virtual clock (ms). */
  now?: number
}

interface Timer {
  id: number
  at: number
  delay: number
  callback: () => void
}

export interface FetchCall {
  url: string
  init?: { method?: string; body?: unknown; headers?: unknown }
}

export interface BrowserVm {
  /** The global object (also `window`). */
  window: Record<string, unknown>
  context: Context
  /** Every script src the page inserted, in order. */
  loaded: string[]
  scriptErrors: Error[]
  assigned: string[]
  fetches: FetchCall[]
  beacons: Array<{ url: string; body: unknown }>
  cookies: CookieJar
  sessionValues: Map<string, string>
  localValues: Map<string, string>
  /** Run a script as the browser would: an error is recorded, never thrown. */
  runScript(source: string): void
  /** Run code and return its completion value; errors propagate (for test probes). */
  evaluate<T = unknown>(source: string): T
  /** Every inline <script> body of an HTML document, in order, each run as its own script. */
  runHtml(html: string): void
  /** Virtual time (ms since the clock started). */
  elapsed(): number
  pendingTimers(): number[]
  /** Advance the virtual clock, running due timers in order and settling promises between them. */
  advance(ms: number): Promise<void>
  /** Settle pending promise callbacks without moving time. */
  settle(): Promise<void>
  /** Report a completed resource to every connected PerformanceObserver. */
  resourceLoaded(url: string): Promise<void>
  observing(): boolean
}

/** Promise callbacks queued by the vm run on the shared microtask queue; a macrotask drains them. */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export function createBrowserVm(options: BrowserVmOptions = {}): BrowserVm {
  const url = new URL(options.url ?? "https://acme.com/")
  const start = options.now ?? Date.UTC(2026, 9, 2, 12, 0, 0)
  let now = start
  const timers: Timer[] = []
  let nextTimer = 0
  const loaded: string[] = []
  const scriptErrors: Error[] = []
  const assigned: string[] = []
  const fetches: FetchCall[] = []
  const beacons: Array<{ url: string; body: unknown }> = []
  const localValues = new Map(Object.entries(options.localStorage ?? {}))
  const sessionValues = options.sessionStorage ?? new Map<string, string>()
  const cookies = createCookieJar(url.hostname, options.cookies ?? [])
  const observers: Array<{ callback: (list: { getEntries(): Array<{ name: string }> }) => void; connected: boolean }> = []

  const storage = (values: Map<string, string>) => ({
    getItem(key: string) {
      if (options.storageThrows) throw new Error("SecurityError")
      return values.has(key) ? values.get(key)! : null
    },
    setItem(key: string, value: string) {
      if (options.storageThrows) throw new Error("SecurityError")
      values.set(key, String(value))
    },
    removeItem(key: string) {
      values.delete(key)
    }
  })

  class FakePerformanceObserver {
    connected = false
    constructor(readonly callback: (list: { getEntries(): Array<{ name: string }> }) => void) {}
    observe() {
      this.connected = true
      observers.push(this)
    }
    disconnect() {
      this.connected = false
    }
  }

  // A Date whose "now" is the virtual clock.
  const RealDate = Date
  function VmDate(this: unknown, ...args: unknown[]) {
    if (!(this instanceof VmDate)) return new RealDate(now).toString()
    return args.length === 0 ? new RealDate(now) : new (RealDate as unknown as new (...a: unknown[]) => Date)(...args)
  }
  VmDate.now = () => now
  VmDate.parse = RealDate.parse
  VmDate.UTC = RealDate.UTC
  VmDate.prototype = RealDate.prototype

  const listeners = new Map<string, Array<(event: unknown) => void>>()
  const addListener = (type: string, listener: (event: unknown) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), listener])
  }

  let context!: Context
  const runScript = (source: string) => {
    try {
      runInContext(source, context)
    } catch (error) {
      scriptErrors.push(error as Error)
    }
  }
  const element = (tagName: string) => {
    const attributes = new Map<string, string>()
    return {
      tagName: tagName.toUpperCase(),
      src: "",
      text: "",
      id: "",
      async: false,
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null
    }
  }
  const head = {
    appendChild(node: Record<string, unknown>) {
      if (typeof node.src === "string" && node.src) loaded.push(node.src)
      if (typeof node.text === "string" && node.text.length > 0) runScript(node.text)
      return node
    }
  }
  const document: Record<string, unknown> = {
    referrer: options.referrer ?? "",
    createElement: element,
    getElementById: () => null,
    getElementsByTagName: () => [
      { parentNode: { insertBefore: (node: Record<string, unknown>) => void loaded.push(String(node.src)) } }
    ],
    addEventListener: addListener,
    head
  }
  Object.defineProperty(document, "cookie", {
    get: () => {
      if (options.cookieThrows) throw new Error("SecurityError")
      return cookies.read()
    },
    set: (value: string) => {
      if (options.cookieThrows) throw new Error("SecurityError")
      cookies.write(value)
    }
  })
  const location = {
    href: url.href,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    origin: url.origin,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    assign: (href: string) => void assigned.push(String(href))
  }
  const global: Record<string, unknown> = {
    document,
    location,
    history: { pushState() {}, replaceState() {} },
    localStorage: storage(localValues),
    sessionStorage: storage(sessionValues),
    navigator: {
      doNotTrack: options.dnt ?? "0",
      globalPrivacyControl: options.gpc ?? false,
      userAgent: options.userAgent ?? "Mozilla/5.0 (Macintosh) TestBrowser/1.0",
      sendBeacon: (target: string, body: unknown) => {
        beacons.push({ url: String(target), body })
        return true
      }
    },
    crypto: webcrypto,
    TextEncoder,
    fetch: (target: string, init?: FetchCall["init"]) => {
      fetches.push({ url: String(target), init })
      return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({}) })
    },
    setTimeout: (callback: () => void, delay?: number) => {
      nextTimer += 1
      const ms = Math.max(0, Number(delay) || 0)
      timers.push({ id: nextTimer, at: now + ms, delay: ms, callback })
      return nextTimer
    },
    clearTimeout: (id: number) => {
      const index = timers.findIndex((timer) => timer.id === id)
      if (index !== -1) timers.splice(index, 1)
    },
    addEventListener: addListener,
    removeEventListener() {},
    dispatchEvent(event: { type: string }) {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return true
    },
    URL,
    URLSearchParams,
    Date: VmDate,
    JSON,
    Math,
    console,
    encodeURIComponent,
    decodeURIComponent
  }
  if (options.performanceObserver !== false) global.PerformanceObserver = FakePerformanceObserver
  global.window = global
  global.self = global
  context = createContext(global)

  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await macrotask()
  }

  return {
    window: global,
    context,
    loaded,
    scriptErrors,
    assigned,
    fetches,
    beacons,
    cookies,
    sessionValues,
    localValues,
    runScript,
    evaluate: <T>(source: string) => runInContext(source, context) as T,
    runHtml(html: string) {
      const pattern = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi
      let match: RegExpExecArray | null
      while ((match = pattern.exec(html)) !== null) {
        if (match[1]!.trim().length > 0) runScript(match[1]!)
      }
    },
    elapsed: () => now - start,
    pendingTimers: () => timers.map((timer) => timer.at - now).sort((a, b) => a - b),
    async advance(ms: number) {
      const target = now + ms
      await settle()
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id)
        const due = timers[0]
        if (!due || due.at > target) break
        timers.shift()
        now = due.at
        due.callback()
        await settle()
      }
      now = target
      await settle()
    },
    settle,
    async resourceLoaded(resource: string) {
      for (const observer of observers) {
        if (observer.connected) observer.callback({ getEntries: () => [{ name: resource }] })
      }
      await settle()
    },
    observing: () => observers.some((observer) => observer.connected)
  }
}

/** The `bootstrapSource` string literal of a managed Next module, decoded (it is JSON-compatible). */
export function decodeNextBootstrap(moduleSource: string): string {
  const match = moduleSource.match(/^const bootstrapSource = (".*")$/m)
  if (!match) throw new Error("No bootstrapSource literal in the managed module.")
  return JSON.parse(match[1]!) as string
}

/** Values built inside the vm belong to another realm; compare their plain JSON shape. */
export const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null))
