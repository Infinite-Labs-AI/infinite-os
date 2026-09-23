// The Meta pixel's DELIVERY check — credential-free, and the only one that catches the failure
// class below.
//
// ON 2026-09-20 the pixel on infinite.fast was "Active" in Meta Pixel Helper, `fbevents.js` and the
// signals config both returned 200, `fbq.getState()` listed the pixel and `eventCount` incremented —
// and it had never sent a single `facebook.com/tr` beacon, never written `_fbp` or `_fbc`, and
// Events Manager showed only Conversions API rows behind a green dot. Nothing in the page bytes was
// wrong. Meta was vetoing every send CLIENT-SIDE, because the pixel's Traffic Permissions allow list
// still named the pre-rebrand domain `ultima.inc` and had never gained `infinite.fast`.
//
// The veto ships as DATA inside the pixel's own DOMAIN-SCOPED config:
//
//     config.set("<pixelId>", "prohibitedPixels", {"lockWebpage":false,"blockReason":"traffic_permissions"});
//     instance.optIn("<pixelId>", "ProhibitedPixels", true);
//
// `lockWebpage:false` is what makes it invisible — `fbq` keeps working and only the transmission is
// dropped, with one console warning nobody reads. Because it is data on a PUBLIC endpoint we can
// assert on it from anywhere, with no Meta credentials and no Graph API call.
//
// TWO properties of the request are load-bearing, both pinned in config-probe.test.ts:
//
//   1. `&domain=` is MANDATORY. Without it Meta serves the GENERIC config, which carries no block
//      directive at all — the omission that cost a night of hand-debugging. A probe without the
//      domain is not a weaker check, it is a check that always passes.
//   2. It is NOT a Graph call. `connect.facebook.net` is an unauthenticated CDN (observed:
//      `cache-control: public, max-age=1200`, ~150 ms, no token), so it spends nothing from the
//      per-ad-account 24h request budget that `history_sync` / `live_read` / `media_archive` share
//      and that Meta throttles at ~250-300 calls. Never reach for the Graph API to answer this.
//
// Observed on a BLOCKED domain, for the same pixel: ~46 KB instead of ~365 KB, and the `cookie` and
// `identity` plugins — the two that write `_fbp` / `_fbc` — are withheld entirely. That is the
// mechanism behind the consequence we report: an ad click lands with no `_fbc`, so Meta cannot
// attribute the conversion to the ad, and the creative gets blamed for the spend.

/** Meta's public, unauthenticated signals CDN. Not the Graph API; spends no request budget. */
export const META_SIGNALS_BASE_URL = "https://connect.facebook.net"

/** The config revision the browser asks for. Kept in one place so a bump is a one-line change. */
export const META_SIGNALS_CONFIG_VERSION = "2.9.403"

export const META_TRAFFIC_PERMISSIONS_HELP =
  "https://www.facebook.com/business/help/278125336598935"

export const META_CONFIG_FETCH_TIMEOUT_MS = 15_000

/**
 * The probe's user agent. Self-identifying, like the server-lane check's: the stable product token
 * leads so a customer allowlisting it is not broken by a version bump, and the URL gives whoever
 * reads a log somewhere to go. This endpoint is a CDN, so nothing here lands in anyone's analytics.
 */
export function metaProbeUserAgent(version: string): string {
  return `infinite-tag-verify/${version} (+https://infinite.fast; meta-pixel-delivery monitor)`
}

export function metaSignalsConfigUrl(pixelId: string, domain: string): string {
  return (
    `${META_SIGNALS_BASE_URL}/signals/config/${encodeURIComponent(pixelId)}` +
    `?v=${META_SIGNALS_CONFIG_VERSION}&r=stable&domain=${encodeURIComponent(domain)}`
  )
}

/**
 * A `config.set("<pixelId>", "<key>", {...})` entry, read out of the config body.
 *
 * THE THREE OUTCOMES ARE DELIBERATELY DISTINCT. A parser that folds "the key is not there" together
 * with "the key is there and I could not read it" turns a broken probe into a PASS — which is the
 * exact failure mode this whole feature exists to kill. `absent` is evidence; `unparseable` is not.
 */
export type MetaConfigEntry =
  | { kind: "absent" }
  | { kind: "present"; value: Record<string, unknown> }
  | { kind: "unparseable"; detail: string }

export function parseMetaConfigEntry(
  configText: string,
  pixelId: string,
  key: string
): MetaConfigEntry {
  const needle = `config.set("${pixelId}", "${key}", `
  const start = configText.indexOf(needle)
  if (start === -1) return { kind: "absent" }

  const open = start + needle.length
  let depth = 0
  for (let index = open; index < configText.length; index += 1) {
    const character = configText[index]
    if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth !== 0) continue
      const slice = configText.slice(open, index + 1)
      try {
        const parsed: unknown = JSON.parse(slice)
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { kind: "unparseable", detail: `${key} is not a JSON object` }
        }
        return { kind: "present", value: parsed as Record<string, unknown> }
      } catch (error) {
        return {
          kind: "unparseable",
          detail: `${key} did not parse as JSON (${error instanceof Error ? error.message : String(error)})`
        }
      }
    }
  }
  return { kind: "unparseable", detail: `${key} has an unterminated object literal` }
}

/**
 * Every `fbq('init', '<pixelId>')` on a page, de-duplicated and in document order. Matches the same
 * bootstrap `buildMetaPixelSnippet` writes and the hand-rolled one Meta's own docs hand out, so it
 * finds pixels this installer never touched — an adopted install is exactly as blockable as ours.
 */
export function extractMetaPixelIds(html: string): string[] {
  const matches = html.matchAll(/fbq\(\s*["']init["']\s*,\s*["'](\d{6,24})["']/g)
  return [...new Set([...matches].map((match) => match[1] as string))]
}

/** What the probe found for ONE pixel on ONE domain. */
export type MetaDeliveryFinding =
  /** No block directive is served for this domain. Sends are ALLOWED — not proof one happened. */
  | { kind: "allowed"; pixelId: string; domain: string }
  /**
   * The allow list does not include this domain: `prohibitedPixels` is served, so the browser leg
   * transmits nothing and no `_fbp` / `_fbc` is written.
   */
  | { kind: "blocked"; pixelId: string; domain: string; blockReason: string; lockWebpage: boolean }
  /** The domain is on the pixel's explicit BLOCK list (`prohibitedSources`, matched on sha256). */
  | { kind: "source_blocked"; pixelId: string; domain: string }
  /** Meta does not serve a config for this id at all (observed: HTTP 404 on a made-up id). */
  | { kind: "pixel_not_found"; pixelId: string; domain: string }
  /**
   * THE PROBE COULD NOT RUN. Never collapse this into `allowed`: a false green on this check is
   * worse than no check, because it is the same silence as the bug.
   */
  | { kind: "unknown"; pixelId: string; domain: string; detail: string }

export interface ProbeMetaDeliveryOptions {
  pixelId: string
  /** The host the pixel runs on, e.g. `infinite.fast`. Bare hostname — no scheme, no path. */
  domain: string
  version: string
  fetch?: typeof fetch
  /** sha256-hex of the domain; injected so the probe stays dependency-free in a browser build. */
  sha256Hex: (input: string) => Promise<string> | string
  timeoutMs?: number
}

/**
 * Ask Meta what it serves this pixel on this domain, and classify the answer.
 *
 * Meta matches the allow list on the REGISTRABLE domain, not the exact string: observed on pixel
 * 914812061724377, `www.` / `hub.` / `app.infinite.fast` all resolve ALLOWED while `infinite.fastx`
 * and `infinite.fast.evil.com` resolve BLOCKED — so subdomains inherit and it is not a substring
 * match. Pass the host the pixel actually runs on and let Meta decide.
 */
export async function probeMetaDelivery(
  options: ProbeMetaDeliveryOptions
): Promise<MetaDeliveryFinding> {
  const { pixelId, domain } = options
  const fetchImpl = options.fetch ?? globalThis.fetch
  const at = { pixelId, domain }

  let status: number
  let body: string
  try {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? META_CONFIG_FETCH_TIMEOUT_MS
    )
    try {
      const response = await fetchImpl(metaSignalsConfigUrl(pixelId, domain), {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": metaProbeUserAgent(options.version), accept: "*/*" },
        signal: controller.signal
      })
      status = response.status
      body = await response.text()
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return {
      kind: "unknown",
      ...at,
      detail: `the pixel config could not be fetched (${error instanceof Error ? error.message : String(error)})`
    }
  }

  if (status === 404) return { kind: "pixel_not_found", ...at }
  if (status < 200 || status >= 300) {
    return { kind: "unknown", ...at, detail: `Meta answered HTTP ${status} for the pixel config` }
  }

  const prohibitedPixels = parseMetaConfigEntry(body, pixelId, "prohibitedPixels")
  if (prohibitedPixels.kind === "unparseable") {
    return { kind: "unknown", ...at, detail: prohibitedPixels.detail }
  }
  if (prohibitedPixels.kind === "present") {
    const blockReason =
      typeof prohibitedPixels.value.blockReason === "string"
        ? prohibitedPixels.value.blockReason
        : "unspecified"
    return {
      kind: "blocked",
      ...at,
      blockReason,
      lockWebpage: prohibitedPixels.value.lockWebpage === true
    }
  }

  // The second, independent way a domain is silenced: the explicit BLOCK list. Its entries carry
  // the domain as a sha256 hex digest, never in the clear.
  const prohibitedSources = parseMetaConfigEntry(body, pixelId, "prohibitedSources")
  if (prohibitedSources.kind === "unparseable") {
    return { kind: "unknown", ...at, detail: prohibitedSources.detail }
  }
  if (prohibitedSources.kind === "present") {
    const entries = prohibitedSources.value.prohibitedSources
    if (Array.isArray(entries) && entries.length > 0) {
      const hashed = await options.sha256Hex(domain)
      const listed = entries.some(
        (entry) =>
          entry !== null &&
          typeof entry === "object" &&
          (entry as { domain?: unknown }).domain === hashed
      )
      if (listed) return { kind: "source_blocked", ...at }
    }
  }

  // A config that reached neither `configLoaded` nor any block directive is not evidence of health —
  // it is a body we did not understand, and it is reported as such.
  if (!body.includes(`instance.configLoaded("${pixelId}")`)) {
    return {
      kind: "unknown",
      ...at,
      detail: "Meta's config carried no block directive and no configLoaded marker for this pixel"
    }
  }

  return { kind: "allowed", ...at }
}
