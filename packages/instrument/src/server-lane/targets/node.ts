// Express / any Node server.
//
// Nothing here auto-wires the customer's server file. There is no reliable, reversible way to find
// "the line before your routes" in an arbitrary app.js — a wrong insertion point silently records
// nothing (mounted after a static handler) or double-counts. So the lane ships as a generated
// module plus ONE line the brief names exactly, and the customer (or their agent) adds it.
import {
  AUTOMATION_USER_AGENT_PATTERN,
  DOCUMENT_EVENT_ID_PREFIX,
  DOCUMENT_REQUEST_EVENT_NAME,
  REFERRER_HOST_PATTERN,
  SERVER_LANE_DELIVERY_TIMEOUT_MS,
  SERVER_LANE_SECRET_ENV,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_ENV,
  SERVER_LANE_SOURCE_KEY_HEADER,
  VISIT_BUCKET_SECONDS,
  VISIT_KEY_MESSAGE_PREFIX
} from "../helpers.js"
import { infiniteServerEventsDestination } from "../../workspace-artifacts.js"

import {
  managedGeneratedFile,
  nonDocumentPrefixes,
  type ServerLaneTargetDefinition,
  type TargetBuildInput
} from "./shared.js"

export const NODE_MODULE_PATH = "lib/infinite-server-lane.js"
export const NODE_OUTCOME_PATH = "lib/infinite-outcome.js"
export const NODE_MIDDLEWARE_EXPORT = "infiniteServerLane"

// Generated import lines live in constants so the package self-containment scanner
// (package-shape.test.ts) never mistakes them for this package's own imports.
const NODE_CRYPTO_IMPORT = 'import { createHmac, randomUUID } from "node:crypto"'
const NODE_LANE_IMPORT =
  'import { infiniteVisitKey, reportInfiniteServerEvent } from "./infinite-server-lane.js"'
const NODE_MOUNT_IMPORT = `import { ${NODE_MIDDLEWARE_EXPORT} } from "./lib/infinite-server-lane.js"`

function jsStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

/** The one line the customer adds, and the import above it. Quoted verbatim in the brief. */
export function nodeMountSnippet(): string {
  return String.raw`${NODE_MOUNT_IMPORT}

// Mount BEFORE your routes and your static handler, so every HTML document passes through it.
app.use(${NODE_MIDDLEWARE_EXPORT}())
`
}

/** lib/infinite-server-lane.js — the Node twin of the edge core (node:crypto, Node >= 18 fetch). */
export function nodeLaneModuleSource(input: TargetBuildInput): string {
  const bakedHosts = jsStringArray(
    input.productionHosts.map((host) => host.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean)
  )
  return managedGeneratedFile(
    [
      "// Infinite server lane — records every HTML document your server serves, and posts outcomes.",
      "// Node >= 18 (global fetch). Secrets come from the environment only:",
      `//   ${SERVER_LANE_SECRET_ENV}  the source's server-event secret (Infinite → Site Analytics → Settings → Conversions → Server events)`,
      `//   ${SERVER_LANE_SOURCE_KEY_ENV}      the public site source key (falls back to the value baked below)`,
      "//",
      `// Mount it once, before your routes:  app.use(${NODE_MIDDLEWARE_EXPORT}())`
    ],
    String.raw`${NODE_CRYPTO_IMPORT}

const INFINITE_SERVER_EVENTS_URL = ${JSON.stringify(infiniteServerEventsDestination(input.apiOrigin))}
const INFINITE_SOURCE_KEY_FALLBACK = ${JSON.stringify(input.siteSourceKey ?? "")}
const INFINITE_PRODUCTION_HOSTS = ${bakedHosts}
const INFINITE_DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const INFINITE_VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}
const INFINITE_DOCUMENT_EVENT_NAME = ${JSON.stringify(DOCUMENT_REQUEST_EVENT_NAME)}
const INFINITE_AUTOMATION_USER_AGENT = /${AUTOMATION_USER_AGENT_PATTERN.source}/i
const INFINITE_NON_DOCUMENT_PREFIXES = ${jsStringArray(nonDocumentPrefixes(input.collectPath))}
const INFINITE_REFERRER_HOST = /${REFERRER_HOST_PATTERN.source}/

const infiniteSecret = () => process.env.${SERVER_LANE_SECRET_ENV} ?? ""
const infiniteSourceKey = () => process.env.${SERVER_LANE_SOURCE_KEY_ENV} || INFINITE_SOURCE_KEY_FALLBACK

const infiniteHmacHex = (secret, message) => createHmac("sha256", secret).update(message, "utf8").digest("hex")

export function infiniteClassifyUserAgent(userAgent) {
  const value = (userAgent ?? "").trim()
  if (value.length === 0) return "unknown"
  return INFINITE_AUTOMATION_USER_AGENT.test(value) ? "automation" : "browser"
}

/** Plain lowercase hostname of the Referer, or undefined — never its path or query. */
export function infiniteReferrerHost(referrer) {
  if (!referrer) return undefined
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    return INFINITE_REFERRER_HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/** Loopback and any host outside the verified production list stay dormant. */
export function infiniteHostAllowed(host) {
  if (!host) return false
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return false
  }
  return INFINITE_PRODUCTION_HOSTS.length === 0 || INFINITE_PRODUCTION_HOSTS.includes(host)
}

/** GET + accepts text/html + not a prefetch + not DNT/GPC + not an asset, API route, or platform internal. */
export function isInfiniteDocumentRequest({ method, path, accept, prefetch = false, dnt = false }) {
  if (method !== "GET" || prefetch) return false
  if (dnt) return false // Do-Not-Track / Global-Privacy-Control, honored like the client pixel does
  if (!String(accept ?? "").toLowerCase().includes("text/html")) return false
  if (INFINITE_NON_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  return !path.slice(path.lastIndexOf("/") + 1).includes(".")
}

/** visitKey = HMAC(secret, "${VISIT_KEY_MESSAGE_PREFIX}" + ip + "|" + userAgent + "|" + 30-minute bucket). The IP never leaves this server. */
export function infiniteVisitKey({ clientIp, userAgent, nowMs = Date.now(), secret = infiniteSecret() }) {
  if (!secret) return null
  const bucket = Math.floor(Math.floor(nowMs / 1000) / INFINITE_VISIT_BUCKET_SECONDS)
  return infiniteHmacHex(secret, ${JSON.stringify(VISIT_KEY_MESSAGE_PREFIX)} + (clientIp ?? "") + "|" + (userAgent ?? "") + "|" + bucket)
}

/**
 * Sign and POST one event. Fire-and-forget: call it as 'void sendInfiniteServerEvent(event)' and
 * never await it in the request path. Resolves true on 2xx; never throws.
 */
export async function sendInfiniteServerEvent(event) {
  const secret = infiniteSecret()
  const sourceKey = infiniteSourceKey()
  if (!secret || !sourceKey) return false
  try {
    const body = JSON.stringify({
      eventId: event.eventId ?? randomUUID(),
      eventName: event.eventName,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      ...(event.accountKey ? { accountKey: event.accountKey } : {}),
      properties: event.properties ?? {},
      // Signed with everything else, so a match block cannot be injected by a third party.
      ...(event.adMatch ? { adMatch: event.adMatch } : {})
    })
    const response = await fetch(INFINITE_SERVER_EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ${JSON.stringify(SERVER_LANE_SOURCE_KEY_HEADER)}: sourceKey,
        ${JSON.stringify(SERVER_LANE_SIGNATURE_HEADER)}: infiniteHmacHex(secret, body)
      },
      body,
      signal: AbortSignal.timeout(INFINITE_DELIVERY_TIMEOUT_MS)
    })
    return response.ok
  } catch {
    return false
  }
}

const INFINITE_NO_REPORT = { accepted: false, duplicate: false, metaEventId: null, metaEventName: null, status: null }

/**
 * Sign and POST one event and resolve Infinite's answer: { accepted, duplicate, metaEventId,
 * metaEventName, status }. All-false / all-null on any failure; never throws. Infinite replies before
 * it calls Meta, so this never waits on Meta.
 */
export async function reportInfiniteServerEvent(event) {
  const secret = infiniteSecret()
  const sourceKey = infiniteSourceKey()
  if (!secret || !sourceKey) return INFINITE_NO_REPORT
  try {
    const body = JSON.stringify({
      eventId: event.eventId ?? randomUUID(),
      eventName: event.eventName,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      ...(event.accountKey ? { accountKey: event.accountKey } : {}),
      properties: event.properties ?? {},
      // Signed with everything else, so a match block cannot be injected by a third party.
      ...(event.adMatch ? { adMatch: event.adMatch } : {})
    })
    const response = await fetch(INFINITE_SERVER_EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ${JSON.stringify(SERVER_LANE_SOURCE_KEY_HEADER)}: sourceKey,
        ${JSON.stringify(SERVER_LANE_SIGNATURE_HEADER)}: infiniteHmacHex(secret, body)
      },
      body,
      signal: AbortSignal.timeout(INFINITE_DELIVERY_TIMEOUT_MS)
    })
    const status = response.status
    if (!response.ok) return { ...INFINITE_NO_REPORT, status }
    let value
    try {
      value = await response.json()
    } catch {
      return { ...INFINITE_NO_REPORT, status }
    }
    if (!value || typeof value !== "object") return { ...INFINITE_NO_REPORT, status }
    const accepted = value.accepted === true
    const duplicate = value.duplicate === true
    const mirror = accepted && !duplicate
    const metaEventName = mirror && typeof value.metaEventName === "string" && value.metaEventName ? value.metaEventName : null
    const metaEventId =
      metaEventName && typeof value.metaEventId === "string" && value.metaEventId ? value.metaEventId : null
    return { accepted, duplicate, metaEventId, metaEventName: metaEventId ? metaEventName : null, status }
  } catch {
    return INFINITE_NO_REPORT
  }
}

/**
 * The Express-style middleware. Mount it once, before your routes and static handler:
 *   app.set("trust proxy", true)   // so req.ip / req.hostname reflect the real client
 *   app.use(${NODE_MIDDLEWARE_EXPORT}())
 */
export function ${NODE_MIDDLEWARE_EXPORT}() {
  return function infiniteServerLaneMiddleware(req, res, next) {
    try {
      const secret = infiniteSecret()
      const path = typeof req.path === "string" ? req.path : String(req.url ?? "").split("?")[0]
      const prefetch = Boolean(req.headers["purpose"] || req.headers["sec-purpose"])
      const dnt = req.headers["dnt"] === "1" || req.headers["sec-gpc"] === "1"
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
        .split(",")[0]
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, "")
        .replace(/\.$/, "") // the one host normaliser: "ACME.com." is "acme.com"
      if (
        secret &&
        infiniteHostAllowed(host) &&
        isInfiniteDocumentRequest({ method: req.method, path, accept: req.headers.accept, prefetch, dnt })
      ) {
        const nowMs = Date.now()
        const userAgent = req.headers["user-agent"] ?? ""
        const clientIp = String(req.headers["x-forwarded-for"] ?? req.ip ?? "").split(",")[0].trim()
        const visitKey = infiniteVisitKey({ clientIp, userAgent, nowMs, secret })
        const referrerHost = infiniteReferrerHost(req.headers.referer)
        void sendInfiniteServerEvent({
          eventId: ${JSON.stringify(DOCUMENT_EVENT_ID_PREFIX)} + infiniteHmacHex(secret, visitKey + "|" + path + "|" + nowMs),
          eventName: INFINITE_DOCUMENT_EVENT_NAME,
          occurredAt: new Date(nowMs).toISOString(),
          properties: {
            path,
            host,
            visitKey,
            userAgentFamily: infiniteClassifyUserAgent(userAgent),
            ...(referrerHost ? { referrerHost } : {})
          }
        })
      }
    } catch {
      // The lane never affects the response.
    }
    next()
  }
}`
  )
}

/** lib/infinite-outcome.js — the same postInfiniteOutcome API as the edge helper, on the Node module. */
export function nodeOutcomeHelperSource(): string {
  return managedGeneratedFile(
    [
      "// Infinite server lane — report an outcome the moment it becomes REAL (row committed,",
      "// payment captured, file served). Never from a click: a click is intent, not an outcome.",
      "//",
      '//   import { postInfiniteOutcome } from "./lib/infinite-outcome.js"',
      "//",
      "// visitKeyInputs accepts a Node request (req — .headers is a plain object, read correctly),",
      "// a WHATWG Request, OR an explicit { clientIp, userAgent }:",
      '//   await postInfiniteOutcome({ type: "purchase", path: "/checkout", accountKey: order.id, visitKeyInputs: req })',
      "//",
      "// Where the browser waits on your response, reportInfiniteOutcome (a STABLE eventId is required)",
      "// returns { accepted, duplicate, metaEventId, metaEventName, status }; hand metaEventId to the page's",
      "// infiniteMetaMirror.",
      "//",
      "// In a WEBHOOK the request is the PROVIDER'S, not the buyer's — compute the key at checkout",
      "// with infiniteVisitKey({ clientIp, userAgent }) from ./infinite-server-lane.js, carry it (e.g.",
      "// Stripe metadata), and pass it as properties: { visitKey } so this skips its own derivation."
    ],
    String.raw`import { createHash } from "node:crypto"
${NODE_LANE_IMPORT}

/**
 * One header value from EITHER a plain object (req.headers on Node/Express) OR a WHATWG Headers
 * (.get). A plain object is the common case on a Node server, so read it correctly rather than
 * dropping the visit key.
 */
function infiniteHeaderValue(headers, name) {
  if (headers && typeof headers.get === "function") {
    return headers.get(name) ?? ""
  }
  const bag = headers ?? {}
  let value = bag[name]
  if (value === undefined) {
    const lower = name.toLowerCase()
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === lower) {
        value = bag[key]
        break
      }
    }
  }
  if (Array.isArray(value)) return value[0] ?? ""
  return typeof value === "string" ? value : ""
}

function infiniteClientIpFrom(headers) {
  const forwarded = infiniteHeaderValue(headers, "x-forwarded-for").split(",")[0].trim()
  if (forwarded) return forwarded
  return infiniteHeaderValue(headers, "cf-connecting-ip").trim() || infiniteHeaderValue(headers, "x-real-ip").trim() || ""
}

/** Normalise a request (Node req with a plain-object .headers, or WHATWG) or the explicit shape. */
function infiniteVisitKeyInputsOf(input) {
  if (!input) return null
  if ("headers" in input && input.headers) {
    const headers = input.headers
    return { clientIp: infiniteClientIpFrom(headers), userAgent: infiniteHeaderValue(headers, "user-agent") }
  }
  return input
}

export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function splitEmail(value) {
  const at = value.lastIndexOf("@")
  if (at <= 0 || at === value.length - 1) return null
  return { local: value.slice(0, at), domain: value.slice(at + 1) }
}

/** Meta's rule: trim + lowercase. Null when the result is not shaped like an email. */
export function normalizeEmailForMeta(email) {
  const normalized = email.trim().toLowerCase()
  return splitEmail(normalized) ? normalized : null
}

export function hashEmailForMeta(email) {
  const normalized = normalizeEmailForMeta(email)
  return normalized ? sha256Hex(normalized) : null
}

/** Meta \`external_id\` — hashing is recommended; the advertiser id keeps its case. */
export function hashExternalId(id) {
  const trimmed = id.trim()
  return trimmed ? sha256Hex(trimmed) : null
}

/** Meta's \`zp\`: lowercase, whitespace and hyphens removed; US ZIP+4 is cut to five. */
export function normalizeZipForMeta(zip) {
  const compact = zip.replace(/[\s-]+/g, "").toLowerCase()
  if (!compact) return null
  if (/^\d{9}$/.test(compact)) return compact.slice(0, 5)
  return compact.slice(0, 32)
}

/** Meta's \`country\`: ISO 3166-1 alpha-2, lowercased. */
export function normalizeCountryForMeta(country) {
  const normalized = country.trim().toLowerCase()
  return /^[a-z]{2}$/.test(normalized) ? normalized : null
}

const META_WHITESPACE_AND_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@ [\]^_\`{|}~\s]+/g
const META_NON_LATIN_ALPHANUMERIC = /[^a-zA-Z0-9]+/g

/** Meta's \`fn\` / \`ln\`: lowercase, no punctuation or whitespace. */
export function normalizeNameForMeta(name) {
  const normalized = name.toLowerCase().replace(META_WHITESPACE_AND_PUNCTUATION, "")
  return normalized ? normalized.slice(0, 64) : null
}

/** Meta's \`ct\`: lowercase, no non-latin alphanumerics, and must start with a latin letter. */
export function normalizeCityForMeta(city) {
  const normalized = city.toLowerCase().replace(META_NON_LATIN_ALPHANUMERIC, "")
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 64) : null
}

const US_STATE_CODES = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co",
  connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id",
  illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky", louisiana: "la",
  maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn",
  mississippi: "ms", missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  newhampshire: "nh", newjersey: "nj", newmexico: "nm", newyork: "ny", northcarolina: "nc",
  northdakota: "nd", ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa",
  rhodeisland: "ri", southcarolina: "sc", southdakota: "sd", tennessee: "tn", texas: "tx",
  utah: "ut", vermont: "vt", virginia: "va", washington: "wa", westvirginia: "wv",
  wisconsin: "wi", wyoming: "wy",
  districtofcolumbia: "dc", washingtondc: "dc",
  puertorico: "pr", guam: "gu", americansamoa: "as", usvirginislands: "vi", virginislands: "vi",
  northernmarianaislands: "mp", unitedstatesminoroutlyingislands: "um",
  armedforcesamericas: "aa", armedforceseurope: "ae", armedforcespacific: "ap"
}
const US_STATE_CODE_SET = new Set(Object.values(US_STATE_CODES))

export function normalizeStateForMeta(state, country) {
  const normalized = state.toLowerCase().replace(META_NON_LATIN_ALPHANUMERIC, "")
  if (!normalized) return null
  if (country && normalizeCountryForMeta(country) === "us") {
    if (US_STATE_CODE_SET.has(normalized)) return normalized
    return US_STATE_CODES[normalized] ?? null
  }
  return normalized.slice(0, 64)
}

export function hashZipForMeta(zip) {
  const normalized = normalizeZipForMeta(zip)
  return normalized ? sha256Hex(normalized) : null
}

export function hashCountryForMeta(country) {
  const normalized = normalizeCountryForMeta(country)
  return normalized ? sha256Hex(normalized) : null
}

export function hashNameForMeta(name) {
  const normalized = normalizeNameForMeta(name)
  return normalized ? sha256Hex(normalized) : null
}

export function hashCityForMeta(city) {
  const normalized = normalizeCityForMeta(city)
  return normalized ? sha256Hex(normalized) : null
}

export function hashStateForMeta(state, country) {
  const normalized = normalizeStateForMeta(state, country)
  return normalized ? sha256Hex(normalized) : null
}

/**
 * Sign and POST one outcome. Resolves true when Infinite acknowledged it; never throws, so a failed
 * report can never fail the checkout, sign-up, or download it describes.
 *
 * type          the exact outcome name from Infinite → Conversions ("sign_up", "purchase", …)
 * path          the page path it belongs to (pathname only — no query string)
 * eventId       stable per outcome (order id, signup id) so retries dedupe
 * accountKey    opaque account or order id; Infinite hashes it at rest
 * visitKeyInputs a Node/WHATWG request OR { clientIp, userAgent }, for same-lane attribution
 * adMatch       await adMatchFromRequest(buyerRequest, { trackingAllowed: pageAllowedAdMatch, email, externalId, fullName, city, state, postcode, country })
 *               — hashed Meta match data, never a phone
 */
const INFINITE_CAMPAIGN_PROVENANCE = ["tab", "cookie", "none"]
const INFINITE_BROWSER_CONTEXT = ["facebook_app", "instagram_app", "other_in_app", "browser", "unknown"]
const INFINITE_NO_REPORT = { accepted: false, duplicate: false, metaEventId: null, metaEventName: null, status: null }

/** Infinite accepts at most this many properties on one event (more and the whole event is refused). */
const INFINITE_MAX_PROPERTIES = 16

function infiniteOutcomePath(path) {
  if (typeof path !== "string") return ""
  const value = path.trim()
  if (!value.startsWith("/") || value.includes("?") || value.includes("#")) return ""
  return value
}

async function infiniteSendOutcome({ type, path, eventId, accountKey, occurredAt, properties, visitKeyInputs, campaign, adMatch }) {
  const outcomePath = infiniteOutcomePath(path)
  if (!outcomePath) return INFINITE_NO_REPORT
  // One clock for the whole call: the event time and the visit-key bucket must agree.
  const nowMs = occurredAt ? occurredAt.getTime() : Date.now()
  const merged = { path: outcomePath, ...(properties ?? {}) }
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined || merged[key] === "") delete merged[key]
  }
  merged.path = outcomePath
  const visitInputs = infiniteVisitKeyInputsOf(visitKeyInputs)
  if (visitInputs && merged.visitKey === undefined) {
    const visitKey = infiniteVisitKey({ clientIp: visitInputs.clientIp, userAgent: visitInputs.userAgent, nowMs })
    if (visitKey) merged.visitKey = visitKey
  }
  // The campaign context rides along only while the event stays within the 16-property limit.
  if (campaign && INFINITE_CAMPAIGN_PROVENANCE.includes(String(campaign.campaignProvenance)) && Object.keys(merged).length < INFINITE_MAX_PROPERTIES) {
    merged.campaign_provenance = String(campaign.campaignProvenance)
  }
  if (campaign && INFINITE_BROWSER_CONTEXT.includes(String(campaign.browserContext)) && Object.keys(merged).length < INFINITE_MAX_PROPERTIES) {
    merged.browser_context = String(campaign.browserContext)
  }
  return reportInfiniteServerEvent({
    eventId,
    eventName: type,
    occurredAt: new Date(nowMs).toISOString(),
    accountKey,
    properties: merged,
    ...(adMatch ? { adMatch } : {})
  })
}

const INFINITE_FB_COOKIE = /^fb\.[0-9]{1,2}\.[0-9]{1,20}\.[A-Za-z0-9_%.-]{1,512}$/

/** EVERY value the Cookie header carries for this name, in the order the browser listed them. */
function infiniteCookieValues(header, name) {
  const values = []
  if (!header) return values
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1) continue
    if (part.slice(0, index).trim() !== name) continue
    values.push(part.slice(index + 1).trim())
  }
  return values
}

/** The NEWEST ad click among every _fbc the browser sent (two can coexist: host-only and domain). */
function infiniteNewestFbc(header) {
  let newest = ""
  for (const value of infiniteCookieValues(header, "_fbc")) {
    if (!INFINITE_FB_COOKIE.test(value)) continue
    if (!newest || Number(value.split(".")[2]) > Number(newest.split(".")[2])) newest = value
  }
  return newest || undefined
}

/** _fbp is a browser id, not a click: the first-listed value, kept only when it has Meta's shape. */
function infiniteFbp(header) {
  const first = infiniteCookieValues(header, "_fbp")[0]
  return first && INFINITE_FB_COOKIE.test(first) ? first : undefined
}

function infiniteNonEmptyString(value) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

const INFINITE_SHA256_HEX = /^[a-f0-9]{64}$/i

function infiniteAddDigest(output, key, value, hasher) {
  if (!value) return
  const digest = hasher(value)
  if (digest) output[key] = digest
}

/**
 * Build an adMatch block from the BUYER'S OWN request (a Node req with a plain-object .headers, or a
 * WHATWG Request) — the same block the edge helper builds. In a webhook the request is the PROVIDER'S:
 * capture the cookies/ip/UA during checkout after explicit page consent, then add the confirmed email/name/address from the
 * payment provider object in the webhook. Never put raw email, name or address in Stripe metadata,
 * never log them, and never send a phone.
 */
export async function adMatchFromRequest(request, match = {}) {
  if (match.trackingAllowed !== true) return {}
  const headers = request.headers
  const cookie = infiniteHeaderValue(headers, "cookie")
  const clientIp = infiniteClientIpFrom(headers)
  const userAgent = infiniteHeaderValue(headers, "user-agent")
  const fbc = infiniteNewestFbc(cookie)
  const fbp = infiniteFbp(cookie)
  const output = {
    ...(fbc ? { fbc } : {}),
    ...(fbp ? { fbp } : {}),
    ...(clientIp ? { client_ip_address: clientIp } : {}),
    ...(userAgent ? { client_user_agent: userAgent } : {})
  }

  infiniteAddDigest(output, "em", infiniteNonEmptyString(match.email), hashEmailForMeta)
  if (!output.em && typeof match.em === "string" && INFINITE_SHA256_HEX.test(match.em)) output.em = match.em.toLowerCase()

  const externalId = match.externalId == null ? null : String(match.externalId)
  infiniteAddDigest(output, "external_id", infiniteNonEmptyString(externalId), hashExternalId)
  if (!output.external_id && typeof match.external_id === "string" && INFINITE_SHA256_HEX.test(match.external_id)) {
    output.external_id = match.external_id.toLowerCase()
  }

  const fullName = infiniteNonEmptyString(match.fullName)
  if (fullName) {
    const tokens = fullName.split(/\s+/).filter(Boolean)
    if (tokens[0]) infiniteAddDigest(output, "fn", tokens[0], hashNameForMeta)
    if (tokens.length > 1) infiniteAddDigest(output, "ln", tokens[tokens.length - 1], hashNameForMeta)
  }

  const country = infiniteNonEmptyString(match.country)
  infiniteAddDigest(output, "ct", infiniteNonEmptyString(match.city), hashCityForMeta)
  infiniteAddDigest(output, "st", infiniteNonEmptyString(match.state), (state) => hashStateForMeta(state, country))
  infiniteAddDigest(output, "zp", infiniteNonEmptyString(match.postcode), hashZipForMeta)
  infiniteAddDigest(output, "country", country, hashCountryForMeta)

  return output
}

// Checkout code computes the visit key from the buyer's request and carries it to the webhook.
export { infiniteVisitKey }

/** Resolves true when Infinite accepted the outcome (the 202's accepted); never throws. */
export async function postInfiniteOutcome(input) {
  return (await infiniteSendOutcome(input)).accepted
}

/**
 * Report one outcome and return Infinite's answer: { accepted, duplicate, metaEventId, metaEventName, status }.
 * eventId is REQUIRED and must be stable for this outcome; calling without one throws at once.
 */
export function reportInfiniteOutcome(input) {
  if (!input || typeof input.eventId !== "string" || input.eventId.trim().length === 0) {
    throw new TypeError("reportInfiniteOutcome needs a stable eventId (an order, subscription or account id).")
  }
  return infiniteSendOutcome({ ...input, eventId: infiniteOutcomeWireId(input.type, input.eventId) })
}

/**
 * The wire eventId of an outcome: "<type>:<eventId>" (a sha256 of the eventId once that would pass 160
 * characters), so one stable id reused for two outcome types (sign_up and trial for one account) never
 * collides in Infinite's dedupe. The echoed metaEventId is this wire id.
 */
function infiniteOutcomeWireId(type, eventId) {
  const wire = String(type) + ":" + eventId
  return wire.length <= 160 ? wire : String(type) + ":" + createHash("sha256").update(eventId, "utf8").digest("hex")
}`
  )
}

export const nodeTarget: ServerLaneTargetDefinition = {
  mode: "node-module",
  label: "Node module + a one-line mount you add",
  installPackages: [],
  files: () => [
    { path: NODE_MODULE_PATH, role: "module" },
    { path: NODE_OUTCOME_PATH, role: "module" }
  ],
  build: (input) => ({
    [NODE_MODULE_PATH]: nodeLaneModuleSource(input),
    [NODE_OUTCOME_PATH]: nodeOutcomeHelperSource()
  })
}
