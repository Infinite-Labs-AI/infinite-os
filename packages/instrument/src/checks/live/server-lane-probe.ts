// §3h.6 The server-lane probe: ONE plain GET of `https://<productionHost>/__infinite_probe/<12 hex>`.
//
// This is the one request in the live checks that deliberately carries NO `Purpose` header: the
// server lane drops prefetches, and this request exists to land one bot-flagged `site_document_request`
// row in the customer's Infinite ledger so a receipt can be read back. That is why it never runs on its
// own: the wizard sends it only in the `real_visit`, and `doctor` only with `--probe-server-lane` AND a
// linked Infinite app (R2-27), so a CI run never adds an unread bot row to a customer's ledger.
//
// `Accept: text/html` (the lane counts documents), the monitor user agent (classed as automation), no
// cookies, and never loaded in a window (that would spend a second page view).
import { LIVE_PROBE_TIMEOUT_MS, liveProbeUserAgent, type LiveProbeDeps } from "./probe.js"

export const SERVER_LANE_PROBE_PREFIX = "/__infinite_probe/" as const

export interface ServerLaneProbeOutcome {
  path: string
  /** The site's HTTP status (the lane records the request whatever the page answers), or 0. */
  status: number
  sentAt: string
  detail: string | null
}

/** A probe path for a run id (or 12 random hex chars when there is none, e.g. doctor). */
export function serverLaneProbePath(idHex: string): string {
  const hex = idHex.replace(/-/g, "").toLowerCase()
  if (!/^[0-9a-f]{12,}$/.test(hex)) throw new Error("the server-lane probe needs at least 12 hex characters")
  return `${SERVER_LANE_PROBE_PREFIX}${hex.slice(0, 12)}`
}

export async function sendServerLaneProbe(
  productionHost: string,
  path: string,
  deps: LiveProbeDeps & { now(): Date }
): Promise<ServerLaneProbeOutcome> {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const url = `https://${productionHost}${path}`
  const sentAt = deps.now().toISOString()
  // A stalled site must not stall doctor: the one request has the same deadline as every live probe.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LIVE_PROBE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      headers: { Accept: "text/html", "User-Agent": liveProbeUserAgent(deps.version), "Cache-Control": "no-cache" },
      signal: controller.signal
    })
    await response.body?.cancel().catch(() => undefined)
    return { path, status: response.status, sentAt, detail: null }
  } catch (error) {
    return { path, status: 0, sentAt, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
