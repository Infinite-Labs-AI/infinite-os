// The one way every T1 live check talks to a live site: a read-only request that says it is a CHECK.
//
// `Purpose: prefetch` IS THE LOAD-BEARING PART (ported from infinite-site @ 9f65b47
// `scripts/verify-live-analytics.mjs` L616-637, `probeHeaders`). A check is not a visit, and a check
// that inflates the numbers it checks is not a check. Infinite's server lane (and infinite.fast's
// middleware) drop a document request that carries `Purpose: prefetch` / `Sec-Purpose: prefetch`
// before they look at the user agent, so a probe carrying it can never become a document row, a
// visit or a page view, however browser-shaped its user agent gets. (Incident d2f1809: the guardrail
// counted its own visits until the header stated the intent.)
//
// The user agent names the product and says "monitor", which the server lane also classifies as
// automation (`server-lane/helpers.ts`), so even a lane that ignored the header would flag the row.
//
// The ONE request that deliberately omits `Purpose` is the server-lane probe (§3h.6), which lives in
// `server-lane-probe.ts` and runs only on an explicit opt-in.
//
// No defaults: every expected id a live check compares against is a parameter. No network in tests:
// `fetch` is always injectable.

export type LiveFetch = typeof fetch

export interface LiveProbeDeps {
  /** Injected in tests (a fixture router or a loopback server); `globalThis.fetch` in production. */
  fetch?: LiveFetch
  /** infinite-tag's version, for the user agent. */
  version: string
  /** Per request. */
  timeoutMs?: number
  /** Attempts per request on a network error / 5xx / 429. Default 2. */
  attempts?: number
  /** Backoff between attempts; injectable so tests never wait. */
  sleep?: (ms: number) => Promise<void>
}

export const LIVE_PROBE_TIMEOUT_MS = 20_000
/** Bodies above this are cut (a page this big is read up to here; a bundle past it is not decoded). */
export const LIVE_PROBE_MAX_BYTES = 4 * 1024 * 1024

/** Self-identifying, and classed as automation by the server lane (`monitor`). */
export function liveProbeUserAgent(version: string): string {
  return `infinite-tag-check/${version} (+https://infinite.fast; analytics monitor)`
}

/** Headers for EVERY live probe at a customer site (§3h, port plan row 21). */
export function probeHeaders(version: string): Record<string, string> {
  return {
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "User-Agent": liveProbeUserAgent(version),
    Purpose: "prefetch"
  }
}

export type ProbeResponse =
  | { ok: true; status: number; text: string; headers: Headers; finalUrl: string }
  | { ok: false; status: number; detail: string; headers: Headers | null }

/** Redirects a followed probe takes at most. */
export const LIVE_PROBE_MAX_REDIRECTS = 10

/**
 * A loopback, private, link-local or unspecified host (by name or literal address; no DNS). A probe of
 * a public site never follows a redirect into one (SSRF, §3h.4 row 1); a site that IS local (a doctor
 * run against a dev server) may redirect within local hosts.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (host.includes(":")) {
    return host === "::" || host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host) || /^::ffff:/.test(host)
  }
  return false
}

/**
 * GET (or HEAD) one URL with the probe headers. `ok:false` carries why; a non-2xx is `ok:false` with
 * its status so callers can tell "the site answered 404" from "the network failed" (`status: 0`).
 * Redirects are followed by hand (at most `LIVE_PROBE_MAX_REDIRECTS`), and never from a public host
 * into a private or loopback one. Bodies are read up to `LIVE_PROBE_MAX_BYTES`, then the stream is
 * cancelled.
 */
export async function probeFetch(
  url: string,
  deps: LiveProbeDeps,
  options: { method?: "GET" | "HEAD"; redirect?: "follow" | "manual"; accept?: string } = {}
): Promise<ProbeResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const attempts = Math.max(1, deps.attempts ?? 2)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const follow = (options.redirect ?? "follow") === "follow"
  let startPrivate: boolean
  try {
    startPrivate = isPrivateHost(new URL(url).hostname)
  } catch {
    return { ok: false, status: 0, detail: `not a URL: ${url}`, headers: null }
  }
  let last: ProbeResponse = { ok: false, status: 0, detail: "not attempted", headers: null }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS)
    try {
      let current = url
      for (let hop = 0; ; hop += 1) {
        const response = await fetchImpl(current, {
          method: options.method ?? "GET",
          redirect: "manual",
          headers: { ...probeHeaders(deps.version), Accept: options.accept ?? "*/*" },
          signal: controller.signal
        })
        const location = response.headers.get("location")
        if (follow && response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => undefined)
          if (hop >= LIVE_PROBE_MAX_REDIRECTS) return { ok: false, status: 0, detail: `more than ${LIVE_PROBE_MAX_REDIRECTS} redirects`, headers: response.headers }
          const next = new URL(location, current)
          if (next.protocol !== "https:" && next.protocol !== "http:") {
            return { ok: false, status: 0, detail: `refused a redirect to a ${next.protocol} URL`, headers: response.headers }
          }
          if (!startPrivate && isPrivateHost(next.hostname)) {
            return { ok: false, status: 0, detail: `refused a redirect into a private or loopback host (${next.hostname})`, headers: response.headers }
          }
          current = next.href
          continue
        }
        const text = options.method === "HEAD" ? "" : await readCapped(response)
        const finalUrl = follow ? current : response.url || url
        if (response.ok || (!follow && response.status >= 300 && response.status < 400)) {
          return { ok: true, status: response.status, text, headers: response.headers, finalUrl }
        }
        last = { ok: false, status: response.status, detail: `HTTP ${response.status}`, headers: response.headers }
        break
      }
      if (last.status !== 0 && last.status < 500 && last.status !== 429) return last
    } catch (error) {
      last = {
        ok: false,
        status: 0,
        detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
        headers: null
      }
    } finally {
      clearTimeout(timer)
    }
    if (attempt < attempts) await sleep(Math.min(1_000 * 2 ** (attempt - 1), 8_000))
  }
  return last
}

/** The body up to `LIVE_PROBE_MAX_BYTES`, read as a stream so a huge or endless body is never buffered. */
async function readCapped(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = LIVE_PROBE_MAX_BYTES - total
    if (value.byteLength >= room) {
      text += decoder.decode(value.subarray(0, room), { stream: true })
      await reader.cancel().catch(() => undefined)
      break
    }
    total += value.byteLength
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

/** `https://host/path` → `https://host`. Throws on an unparseable URL. */
export function originOf(url: string): string {
  return new URL(url).origin
}
