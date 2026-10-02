// First-touch campaign attribution on the SERVER — ported from infinite.fast.
//
// Source: `scripts/lib/campaign-cookie.mjs` @ 9f65b47 (`campaignCookieHeader` L7-25, `withCampaignCookie`
// L28-42), wired at infinite-site `middleware.js` L277.
//
// WHY A SERVER COOKIE AS WELL. The browser capture (`./capture.ts`) cannot run when the visitor blocks
// scripts, and Safari caps a script-written cookie at 7 days. A Set-Cookie on the landing document
// survives both, so the campaign is still known when the visitor converts weeks later.
//
// THE RULES (verbatim): GET over https only; never replaces an existing record (first touch); the same
// `projectCampaignCookie` as the browser, so the two records differ only in their version (`v: 2` here,
// `v: 1` in the browser); a 3800-byte inclusive ceiling, skipped whole when exceeded; 180 days; only a
// 2xx `text/html` document is decorated; and a failure costs the campaign evidence, never the page.
//
// GENERALISED: infinite.fast allows only its verified production hosts (L10). A customer's site gets the
// preview guard instead (`../host-guard.ts`, deny mode): production and unknown hosts set the cookie,
// previews and loopback do not.
//
// A customer's server cannot import infinite-tag, so `campaignCookieModuleSource` emits the same logic as
// a self-contained ES module for the server lane to mount; `attribution.test.ts` runs both and requires
// byte-identical headers.
import { buildHostGuardExpression, hostGuardAllows, normalizeHostGuardSpec } from "../host-guard.js"
import { campaignMetadata, projectCampaignCookie } from "./capture.js"
import { CAMPAIGN_COOKIE_VALUE_MAX_BYTES, CAMPAIGN_KEY, SERVER_CAMPAIGN_COOKIE_MAX_AGE } from "./patterns.js"

/** The deny-mode preview guard the server cookie follows (the same lists the browser guard uses). */
export interface CampaignCookieGuard {
  exempt: string[]
  deny: string[]
}

export interface CampaignCookieRequest {
  url: string
  method: string
  headers: { get(name: string): string | null }
}

/** The Set-Cookie value for a landing document, or null when nothing should be written. */
export function campaignCookieHeader(
  request: CampaignCookieRequest,
  guard: CampaignCookieGuard,
  now: number = Date.now()
): string | null {
  const url = new URL(request.url)
  if (request.method !== "GET" || url.protocol !== "https:") return null
  if (!hostGuardAllows(url.hostname, { mode: "deny", exempt: guard.exempt, deny: guard.deny })) return null
  if ((request.headers.get("cookie") || "").split(";").some((part) => part.trim().startsWith(CAMPAIGN_KEY + "="))) {
    return null
  }
  const params = url.searchParams
  const payload: Record<string, unknown> = {}
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
    payload[key] = (params.get(key) || "").replace(/[^\x20-\x7E]/g, "").trim().slice(0, 128)
  }
  for (const key of ["gclid", "fbclid", "msclkid", "ttclid"]) payload["has_" + key] = Boolean(params.get(key))
  payload.landing_path = url.pathname || "/"
  Object.assign(payload, campaignMetadata(url.search, request.headers.get("referer") || "", guard.exempt, now))
  const record = projectCampaignCookie(payload, params, 2)
  if (!record) return null
  const encoded = encodeURIComponent(JSON.stringify(record))
  if (encoded.length > CAMPAIGN_COOKIE_VALUE_MAX_BYTES) return null
  return CAMPAIGN_KEY + "=" + encoded + "; Path=/; Max-Age=" + SERVER_CAMPAIGN_COOKIE_MAX_AGE + "; SameSite=Lax; Secure"
}

export interface WithCampaignCookieOptions {
  guard: CampaignCookieGuard
  isDocument(request: CampaignCookieRequest): boolean
  now?: () => number
}

/** Decorate the FINAL composed response; never change routing, body, cache policy or other cookies. */
export function withCampaignCookie<R extends CampaignCookieRequest>(
  handler: (request: R) => Promise<Response>,
  options: WithCampaignCookieOptions
): (request: R) => Promise<Response> {
  return async (request) => {
    const response = await handler(request)
    try {
      if (response.status < 200 || response.status >= 300 || !options.isDocument(request)) return response
      const contentType = response.headers.get("content-type")
      if (contentType && !contentType.toLowerCase().includes("text/html")) return response
      const cookie = campaignCookieHeader(request, options.guard, (options.now ?? Date.now)())
      if (!cookie) return response
      const headers = new Headers(response.headers)
      headers.append("Set-Cookie", cookie)
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
    } catch {
      return response // storage/format trouble costs campaign evidence, never the page
    }
  }
}

/**
 * The same server cookie as a self-contained ES module (no imports), for a customer's server lane:
 *   export function infiniteCampaignCookieHeader(request, now?)
 *   export function withInfiniteCampaignCookie(handler, { isDocument, now? })
 * The guard lists are baked in as literals. Free of backticks and `${`, so it can sit inside the
 * generated-source templates.
 */
export function campaignCookieModuleSource(guard: CampaignCookieGuard): string {
  const spec = normalizeHostGuardSpec({ mode: "deny", exempt: guard.exempt, deny: guard.deny })
  const exempt = spec.mode === "deny" ? spec.exempt : []
  return [
    "// Managed by Infinite. First-touch campaign cookie for landing documents (infinite-tag).",
    `const INFINITE_CAMPAIGN_KEY = ${JSON.stringify(CAMPAIGN_KEY)}`,
    `const INFINITE_CAMPAIGN_MAX_AGE = ${SERVER_CAMPAIGN_COOKIE_MAX_AGE}`,
    `const INFINITE_CAMPAIGN_MAX_BYTES = ${CAMPAIGN_COOKIE_VALUE_MAX_BYTES}`,
    `const INFINITE_OWN_HOSTS = ${JSON.stringify(exempt)}`,
    `const infiniteCampaignMetadata = ${campaignMetadata.toString()}`,
    `const infiniteProjectCampaignCookie = ${projectCampaignCookie.toString()}`,
    "function infiniteCampaignHostAllowed(host) {",
    `  return ${buildHostGuardExpression(spec, { hostExpression: "host" })}`,
    "}",
    "export function infiniteCampaignCookieHeader(request, now) {",
    "  const url = new URL(request.url)",
    '  if (request.method !== "GET" || url.protocol !== "https:") return null',
    "  if (!infiniteCampaignHostAllowed(url.hostname)) return null",
    '  if ((request.headers.get("cookie") || "").split(";").some((part) => part.trim().startsWith(INFINITE_CAMPAIGN_KEY + "="))) return null',
    "  const params = url.searchParams",
    "  const payload = {}",
    '  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {',
    '    payload[key] = (params.get(key) || "").replace(/[^\\x20-\\x7E]/g, "").trim().slice(0, 128)',
    "  }",
    '  for (const key of ["gclid", "fbclid", "msclkid", "ttclid"]) payload["has_" + key] = Boolean(params.get(key))',
    '  payload.landing_path = url.pathname || "/"',
    '  Object.assign(payload, infiniteCampaignMetadata(url.search, request.headers.get("referer") || "", INFINITE_OWN_HOSTS, now === undefined ? Date.now() : now))',
    "  const record = infiniteProjectCampaignCookie(payload, params, 2)",
    "  if (!record) return null",
    "  const encoded = encodeURIComponent(JSON.stringify(record))",
    "  if (encoded.length > INFINITE_CAMPAIGN_MAX_BYTES) return null",
    '  return INFINITE_CAMPAIGN_KEY + "=" + encoded + "; Path=/; Max-Age=" + INFINITE_CAMPAIGN_MAX_AGE + "; SameSite=Lax; Secure"',
    "}",
    "export function withInfiniteCampaignCookie(handler, options) {",
    "  return async (request) => {",
    "    const response = await handler(request)",
    "    try {",
    "      if (response.status < 200 || response.status >= 300 || !options.isDocument(request)) return response",
    '      const contentType = response.headers.get("content-type")',
    '      if (contentType && !contentType.toLowerCase().includes("text/html")) return response',
    "      const cookie = infiniteCampaignCookieHeader(request, options.now ? options.now() : undefined)",
    "      if (!cookie) return response",
    "      const headers = new Headers(response.headers)",
    '      headers.append("Set-Cookie", cookie)',
    "      return new Response(response.body, { status: response.status, statusText: response.statusText, headers })",
    "    } catch {",
    "      return response",
    "    }",
    "  }",
    "}",
    ""
  ].join("\n")
}
