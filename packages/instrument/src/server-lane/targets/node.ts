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
import { INFINITE_SERVER_EVENTS_DESTINATION } from "../../workspace-artifacts.js"

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
  'import { infiniteVisitKey, sendInfiniteServerEvent } from "./infinite-server-lane.js"'
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
    input.productionHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)
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

const INFINITE_SERVER_EVENTS_URL = ${JSON.stringify(INFINITE_SERVER_EVENTS_DESTINATION)}
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

/** GET + accepts text/html + not a prefetch + not an asset, API route, or platform internal. */
export function isInfiniteDocumentRequest({ method, path, accept, prefetch = false }) {
  if (method !== "GET" || prefetch) return false
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
      properties: event.properties ?? {}
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
      const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
        .split(",")[0]
        .trim()
        .toLowerCase()
        .replace(/:\d+$/, "")
      if (
        secret &&
        infiniteHostAllowed(host) &&
        isInfiniteDocumentRequest({ method: req.method, path, accept: req.headers.accept, prefetch })
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
      '//   await postInfiniteOutcome({ type: "purchase", path: "/checkout", accountKey: order.id,',
      '//     visitKeyInputs: { clientIp: req.ip, userAgent: req.headers["user-agent"] } })'
    ],
    String.raw`${NODE_LANE_IMPORT}

/**
 * Sign and POST one outcome. Resolves true when Infinite acknowledged it; never throws, so a failed
 * report can never fail the checkout, sign-up, or download it describes.
 *
 * type          the exact outcome name from Infinite → Conversions ("sign_up", "purchase", …)
 * path          the page path it belongs to (pathname only — no query string)
 * eventId       stable per outcome (order id, signup id) so retries dedupe
 * accountKey    opaque account or order id; Infinite hashes it at rest
 * visitKeyInputs { clientIp, userAgent } from the request, for same-lane attribution
 */
export async function postInfiniteOutcome({
  type,
  path,
  eventId,
  accountKey,
  occurredAt,
  properties,
  visitKeyInputs
}) {
  // One clock for the whole call: the event time and the visit-key bucket must agree.
  const nowMs = occurredAt ? occurredAt.getTime() : Date.now()
  const merged = { ...(properties ?? {}) }
  if (path) merged.path = path
  if (visitKeyInputs && merged.visitKey === undefined) {
    const visitKey = infiniteVisitKey({ ...visitKeyInputs, nowMs })
    if (visitKey) merged.visitKey = visitKey
  }
  return sendInfiniteServerEvent({
    eventId,
    eventName: type,
    occurredAt: new Date(nowMs).toISOString(),
    accountKey,
    properties: merged
  })
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
