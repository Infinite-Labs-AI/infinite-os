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

/**
 * GET (or HEAD) one URL with the probe headers. `ok:false` carries why; a non-2xx is `ok:false` with
 * its status so callers can tell "the site answered 404" from "the network failed" (`status: 0`).
 */
export async function probeFetch(
  url: string,
  deps: LiveProbeDeps,
  options: { method?: "GET" | "HEAD"; redirect?: "follow" | "manual"; accept?: string } = {}
): Promise<ProbeResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const attempts = Math.max(1, deps.attempts ?? 2)
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let last: ProbeResponse = { ok: false, status: 0, detail: "not attempted", headers: null }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS)
    try {
      const response = await fetchImpl(url, {
        method: options.method ?? "GET",
        redirect: options.redirect ?? "follow",
        headers: { ...probeHeaders(deps.version), Accept: options.accept ?? "*/*" },
        signal: controller.signal
      })
      const text = options.method === "HEAD" ? "" : await readCapped(response)
      const finalUrl = response.url || url
      if (response.ok || (options.redirect === "manual" && response.status >= 300 && response.status < 400)) {
        return { ok: true, status: response.status, text, headers: response.headers, finalUrl }
      }
      last = { ok: false, status: response.status, detail: `HTTP ${response.status}`, headers: response.headers }
      if (response.status < 500 && response.status !== 429) return last
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

async function readCapped(response: Response): Promise<string> {
  const text = await response.text()
  return text.length > LIVE_PROBE_MAX_BYTES ? text.slice(0, LIVE_PROBE_MAX_BYTES) : text
}

/** `https://host/path` → `https://host`. Throws on an unparseable URL. */
export function originOf(url: string): string {
  return new URL(url).origin
}
