// The cancelling recorders behind every way a T0 page can send something (lane O6): `fetch`,
// `navigator.sendBeacon`, `Image().src` / `<img src>`, `XMLHttpRequest`, form submissions, inserted
// scripts and top-level navigations. Each one writes a `T0Request` and answers with a SYNTHETIC
// response on virtual time; no byte leaves the process (and the process itself has no network on macOS).
//
// infinite.fast's executor resolved every fetch `{ok:true}` at once (`test-inject-analytics.mjs`
// L1050-1055), which hid every "the page navigated before the request finished" race. Here an answer
// comes from the scenario's response rules after a delay, can hang forever, and a Meta `/tr` request
// "completes" only after its delay, when the fake PerformanceObserver hears about it.
import type { VirtualClock } from "./clock.js"
import type { T0Request, T0RequestKind, T0ResponseRule, T0TimelineEntry } from "./protocol.js"

const MAX_RECORDED_BODY = 64 * 1024

/** JSON-safe copy of call arguments (functions and cycles become markers; depth-limited). */
export function jsonSafe(value: unknown, depth = 0, seen: Set<unknown> = new Set()): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === "function") return "[function]"
  if (typeof value === "string") return value.length > 4096 ? `${value.slice(0, 4096)}…` : value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "bigint" || typeof value === "symbol") return String(value)
  if (depth > 6) return "[deep]"
  if (seen.has(value)) return "[cycle]"
  seen.add(value)
  try {
    if (Array.isArray(value) || isArguments(value)) return Array.from(value as ArrayLike<unknown>, (item) => jsonSafe(item, depth + 1, seen))
    if (value instanceof Date) return value.toISOString()
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).slice(0, 64)) out[key] = jsonSafe((value as Record<string, unknown>)[key], depth + 1, seen)
    return out
  } catch {
    return "[unreadable]"
  } finally {
    seen.delete(value)
  }
}

function isArguments(value: unknown): boolean {
  return Object.prototype.toString.call(value) === "[object Arguments]"
}

/** A request body as text (strings, URLSearchParams, Blob-likes, FormData-likes, JSON objects). */
export function bodyText(body: unknown): string | null {
  if (body === undefined || body === null) return null
  let text: string
  if (typeof body === "string") text = body
  else if (body instanceof URLSearchParams) text = body.toString()
  else if (typeof (body as { __t0Text?: unknown }).__t0Text === "string") text = (body as { __t0Text: string }).__t0Text
  else if (typeof body === "object") {
    try {
      text = JSON.stringify(body)
    } catch {
      text = String(body)
    }
  } else text = String(body)
  return text.length > MAX_RECORDED_BODY ? text.slice(0, MAX_RECORDED_BODY) : text
}

export class T0Recorder {
  readonly requests: T0Request[] = []
  readonly timeline: T0TimelineEntry[] = []
  action = 0
  private seq = 0

  constructor(private readonly clock: VirtualClock) {}

  record(kind: T0RequestKind, method: string, url: string, body: string | null, origin: T0Request["origin"] = "page"): T0Request {
    const request: T0Request = { seq: this.seq++, at: this.clock.elapsed, action: this.action, kind, method: method.toUpperCase(), url, body, origin }
    this.requests.push(request)
    if (kind !== "script") this.timeline.push({ at: request.at, action: this.action, kind: kind === "navigation" ? "navigate" : "request", args: [kind, request.method, url] })
    return request
  }

  mark(kind: T0TimelineEntry["kind"], args: unknown[], queued = false): void {
    this.timeline.push({ at: this.clock.elapsed, action: this.action, kind, args: jsonSafe(args) as unknown[], ...(queued ? { queued: true } : {}) })
  }
}

export interface FetchResponseLike {
  ok: boolean
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
  text(): Promise<string>
  clone(): FetchResponseLike
}

function responseFor(rule: T0ResponseRule | undefined): FetchResponseLike {
  const status = rule?.status ?? 204
  const text = rule?.json !== undefined ? JSON.stringify(rule.json) : (rule?.text ?? "")
  const response: FetchResponseLike = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" && rule?.json !== undefined ? "application/json" : null) },
    json: () => Promise.resolve(text ? JSON.parse(text) : null),
    text: () => Promise.resolve(text),
    clone: () => responseFor(rule)
  }
  return response
}

export function matchRule(rules: readonly T0ResponseRule[], url: string, method: string): T0ResponseRule | undefined {
  return rules.find((rule) => url.includes(rule.urlIncludes) && (!rule.method || rule.method.toUpperCase() === method.toUpperCase()))
}

export interface RecorderEnv {
  recorder: T0Recorder
  clock: VirtualClock
  rules: readonly T0ResponseRule[]
  resolveUrl(raw: string): string
  beaconRefuses: boolean
  /** Called with every request URL so the vendor stubs can react (e.g. a /tr image "completes"). */
  onImageRequest(url: string, request: T0Request, complete: () => void): void
}

/** `fetch`: recorded, answered from the rules after their delay (default 20 ms, 204). */
export function createFetch(env: RecorderEnv): (input: unknown, init?: { method?: string; body?: unknown }) => Promise<FetchResponseLike> {
  return (input, init) => {
    const url = env.resolveUrl(typeof input === "string" ? input : String((input as { url?: unknown })?.url ?? input))
    const method = String(init?.method ?? (input as { method?: unknown })?.method ?? "GET")
    env.recorder.record("fetch", method, url, bodyText(init?.body))
    const rule = matchRule(env.rules, url, method)
    if (rule?.hang) return new Promise(() => undefined)
    return new Promise((resolve) => {
      env.clock.setTimeout(() => resolve(responseFor(rule)), rule?.delayMs ?? 20)
    })
  }
}

export function createSendBeacon(env: RecorderEnv): (url: unknown, body?: unknown) => boolean {
  return (url, body) => {
    env.recorder.record("beacon", "POST", env.resolveUrl(String(url)), bodyText(body))
    return !env.beaconRefuses
  }
}

/** `XMLHttpRequest`: open/send recorded at send; onload/onreadystatechange fire from the rules. */
export function createXhrClass(env: RecorderEnv): unknown {
  return class T0XMLHttpRequest {
    readyState = 0
    status = 0
    responseText = ""
    response: unknown = ""
    withCredentials = false
    onload: ((event: unknown) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    onreadystatechange: ((event: unknown) => void) | null = null
    private method = "GET"
    private url = ""
    private listeners = new Map<string, Array<(event: unknown) => void>>()
    open(method: string, url: string): void {
      this.method = String(method)
      this.url = env.resolveUrl(String(url))
      this.readyState = 1
    }
    setRequestHeader(): void {}
    getResponseHeader(): string | null {
      return null
    }
    addEventListener(type: string, fn: (event: unknown) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
    }
    abort(): void {}
    send(body?: unknown): void {
      env.recorder.record("xhr", this.method, this.url, bodyText(body))
      const rule = matchRule(env.rules, this.url, this.method)
      if (rule?.hang) return
      env.clock.setTimeout(() => {
        const answer = responseFor(rule)
        this.readyState = 4
        this.status = answer.status
        this.responseText = rule?.json !== undefined ? JSON.stringify(rule.json) : (rule?.text ?? "")
        this.response = this.responseText
        const event = { type: "load", target: this }
        this.onreadystatechange?.(event)
        this.onload?.(event)
        for (const fn of this.listeners.get("load") ?? []) fn(event)
        for (const fn of this.listeners.get("readystatechange") ?? []) fn(event)
      }, rule?.delayMs ?? 20)
    }
  }
}
