// Host helpers for the live checks. The deny rules are READ from `HOST_DENY_V1` (§3h.9, the same list
// the preview guard and 1bu-1 use), never copied, and every host goes through the one normaliser.
import { HOST_DENY_V1, normalizeHost } from "../../wizard/contracts/host-deny.js"

/** Is this host preview / local shaped by §3h.9 (`localhost`, `*.vercel.app`, …)? */
export function isDeniedHost(raw: string): boolean {
  const host = normalizeHost(raw)
  if (HOST_DENY_V1.deny.exact.includes(host)) return true
  return HOST_DENY_V1.deny.suffix.some((suffix) => host.endsWith(suffix))
}

/**
 * Public suffixes with more than one label that sites commonly sit under. NOT the full Public Suffix
 * List (no dependency): a host under an unlisted multi-label suffix is grouped one label too high,
 * which can only cause an extra probe, never a skipped one.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "ne.jp", "or.jp",
  "com.br", "net.br", "com.mx", "com.ar", "com.co",
  "co.in", "net.in", "org.in", "firm.in",
  "co.za", "com.sg", "com.my", "com.hk", "com.tw", "com.cn", "com.tr", "co.il", "co.kr",
  "vercel.app", "netlify.app", "pages.dev", "github.io", "herokuapp.com", "web.app", "firebaseapp.com"
])

/** The registrable domain (eTLD+1) of a host, by the heuristic above. IPs and single labels are returned as is. */
export function registrableDomain(raw: string): string {
  const host = normalizeHost(raw)
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return host
  const labels = host.split(".")
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join(".")
  if (MULTI_LABEL_SUFFIXES.has(lastTwo)) return labels.slice(-3).join(".")
  return lastTwo
}
