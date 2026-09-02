// Server lane (lossless analytics) — the pure recipe, in Node.
//
// These helpers ARE the contract: the customer's server computes exactly these values before it
// posts to Infinite, and the receiving side recomputes nothing about identity — the raw IP and the
// full user agent never leave the customer's server. The generated Next.js module (runtime-source.ts)
// re-implements the same recipe with WebCrypto for the Edge runtime; its constants are interpolated
// from here so the two cannot drift, and runtime-source.test.ts executes the generated code against
// these vectors.
import { createHash, createHmac } from "node:crypto"

import { INFINITE_SERVER_EVENTS_DESTINATION } from "../workspace-artifacts.js"

export const SERVER_LANE_SOURCE_KEY_HEADER = "x-infinite-source-key"
export const SERVER_LANE_SIGNATURE_HEADER = "x-infinite-signature"

/** The two customer env vars. The secret is minted once in the Infinite desktop and never written to disk by infinite-tag. */
export const SERVER_LANE_SECRET_ENV = "INFINITE_SERVER_EVENT_SECRET"
export const SERVER_LANE_SOURCE_KEY_ENV = "INFINITE_SITE_SOURCE_KEY"

export const DOCUMENT_REQUEST_EVENT_NAME = "site_document_request"
/** visitKey rotates every 30 minutes: floor(epochSeconds / 1800). */
export const VISIT_BUCKET_SECONDS = 1800
/** Delivery is fire-and-forget with a hard 2 s ceiling — it must never hold a response. */
export const SERVER_LANE_DELIVERY_TIMEOUT_MS = 2000
export const DOCUMENT_EVENT_ID_PREFIX = "doc:"
export const VISIT_KEY_MESSAGE_PREFIX = "visit:"

export type UserAgentFamily = "browser" | "automation" | "unknown"

/**
 * A small, conservative automation list. It only has to catch the obvious non-humans; the
 * receiving side never sees the UA and records the family as sent (a UA-based FLOOR — browser-faking
 * automation lands on the human side, as it does for any server log). Anything unmatched with a
 * non-empty UA is "browser".
 */
export const AUTOMATION_USER_AGENT_PATTERN =
  /bot\b|crawler|spider|headless|preview|monitor|curl\/|wget\/|python-requests|python-urllib|go-http-client|okhttp|java\/|libwww|scrapy|phantomjs|selenium|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|facebookexternalhit|slackbot|twitterbot|discordbot|linkedinbot|whatsapp|telegrambot|applebot|bingpreview|ahrefs|semrush|mj12bot|bytespider|dataforseo|node-fetch|axios\/|http-client|httpclient/i

/** Path prefixes and shapes that are never a document: assets, Next internals, API routes. */
export const NON_DOCUMENT_PATH_PREFIXES = ["/api/", "/_next/", "/_vercel/"] as const

/** A plain lowercase hostname (what the receiving side accepts for referrerHost); anything else is omitted. */
export const REFERRER_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/

/** Hex HMAC-SHA256 of `message` under `secret` — the one primitive every recipe below uses. */
export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message, "utf8").digest("hex")
}

/** The lane signature: hex HMAC-SHA256 of the RAW request body under the server-event secret. */
export function signServerEventBody(secret: string, rawBody: string): string {
  return hmacHex(secret, rawBody)
}

export interface VisitKeyInput {
  secret: string
  clientIp: string
  userAgent: string
  epochSeconds: number
}

/** visitKey = hex HMAC-SHA256(secret, "visit:" + clientIp + "|" + userAgent + "|" + floor(epochSeconds / 1800)). */
export function computeVisitKey(input: VisitKeyInput): string {
  const bucket = Math.floor(input.epochSeconds / VISIT_BUCKET_SECONDS)
  return hmacHex(
    input.secret,
    `${VISIT_KEY_MESSAGE_PREFIX}${input.clientIp}|${input.userAgent}|${bucket}`
  )
}

export interface DocumentEventIdInput {
  secret: string
  visitKey: string
  path: string
  occurredAtMs: number
}

/** eventId = "doc:" + hex HMAC-SHA256(secret, visitKey + "|" + path + "|" + occurredAtMs) — retry-idempotent. */
export function computeDocumentEventId(input: DocumentEventIdInput): string {
  return `${DOCUMENT_EVENT_ID_PREFIX}${hmacHex(
    input.secret,
    `${input.visitKey}|${input.path}|${input.occurredAtMs}`
  )}`
}

export function classifyUserAgent(userAgent: string | null | undefined): UserAgentFamily {
  const value = (userAgent ?? "").trim()
  if (value.length === 0) return "unknown"
  return AUTOMATION_USER_AGENT_PATTERN.test(value) ? "automation" : "browser"
}

/** True when the path can be a document: not an API route, not a Next internal, no file extension. */
export function isDocumentPath(path: string): boolean {
  if (!path.startsWith("/")) return false
  if (NON_DOCUMENT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  const lastSegment = path.slice(path.lastIndexOf("/") + 1)
  return !lastSegment.includes(".")
}

export interface DocumentRequestGateInput {
  method: string
  path: string
  accept: string | null | undefined
  /** Any prefetch marker: `purpose`, `sec-purpose`, `next-router-prefetch`, `x-middleware-prefetch`. */
  prefetch: boolean
}

/** The skip rules, in one place: GET + document path + accepts text/html + not a prefetch. */
export function shouldRecordDocumentRequest(input: DocumentRequestGateInput): boolean {
  if (input.method !== "GET") return false
  if (input.prefetch) return false
  if (!input.accept || !input.accept.toLowerCase().includes("text/html")) return false
  return isDocumentPath(input.path)
}

/** Hostname of a referrer URL (plain lowercase host only), or undefined. Never the path or query. */
export function referrerHostOf(referrer: string | null | undefined): string | undefined {
  if (!referrer) return undefined
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    return REFERRER_HOST_PATTERN.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/** First hop of x-forwarded-for, else x-real-ip, else "" — the IP is hashed and never sent. */
export function clientIpFrom(headers: {
  forwardedFor?: string | null
  realIp?: string | null
  fallback?: string | null
}): string {
  const forwarded = headers.forwardedFor?.split(",")[0]?.trim()
  if (forwarded) return forwarded
  const real = headers.realIp?.trim()
  if (real) return real
  return headers.fallback?.trim() ?? ""
}

export interface DocumentRequestEventInput {
  secret: string
  path: string
  host: string
  clientIp: string
  userAgent: string
  referrer?: string | null
  nowMs: number
}

/**
 * The OPTIONAL ad-match block on an OUTCOME (never on a document request).
 *
 * WHY IT EXISTS: a founder who runs Meta ads and has no PostHog otherwise has no server-side
 * conversion path — Meta's optimiser never learns about a purchase their server confirmed, because
 * a browser pixel cannot see a server-side truth. When the founder turns the relay on in Infinite,
 * an outcome carrying this block is forwarded to Meta's Conversions API at ingest and the block is
 * then DISCARDED: it is never stored, never written to the ledger, never logged. A PostHog customer
 * needs none of it — PostHog ships its own Meta destination, and two senders for one conversion is
 * a double count.
 *
 * YOUR SERVER HASHES; INFINITE NEVER DOES. `em` and `external_id` are sha256 hex you compute
 * (`hashInfiniteEmail` below is exactly that recipe), so a raw email never leaves your process. A
 * value that is not a 64-character hex digest is REJECTED at ingest with a 400 — deliberately, so
 * an integration mistake surfaces now rather than as a mysteriously empty match rate later.
 *
 * `fbc` and `fbp` are Meta's OWN first-party cookies on your domain, readable by your server:
 * https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
 *
 * ⚠ `client_ip_address` AND `client_user_agent` ARE THE BUYER'S BROWSER'S, AND ONLY YOU HAVE THEM.
 * Meta's spec calls them "the IP address of the browser" and "the user agent for the browser …
 * required for website events shared using the Conversions API". The call you make to Infinite is
 * SERVER-TO-SERVER, so Infinite's view of it is your Vercel/Node egress ip and a `node` user agent —
 * useless to Meta, and actively harmful (it scores an impossible ip/UA pair against your event). So
 * copy them off YOUR OWN inbound browser request and put them in the block. `adMatchFromRequest`
 * does exactly that. Without `client_user_agent` the relay declines to send the event at all.
 *
 * WHOSE MISTAKE COSTS WHAT. `em`/`external_id` are your own computation, so a malformed one is a
 * 400 you should hear about. Everything else here is copied from a VISITOR-controlled request — a
 * browser or extension can set `_fbc` to anything — so a malformed one is silently dropped and your
 * outcome is still recorded. A stranger's cookie can never delete your purchase.
 *
 * The block rides INSIDE the signed body, so nobody without your secret can inject one.
 */
export interface InfiniteAdMatch {
  /** sha256 hex of the lowercased, trimmed email. Use `hashInfiniteEmail`. */
  em?: string
  /** Meta's `_fbc` cookie, verbatim. */
  fbc?: string
  /** Meta's `_fbp` cookie, verbatim. */
  fbp?: string
  /** sha256 hex of your own account id. */
  external_id?: string
  /** The BUYER'S BROWSER ip, from YOUR inbound request. Never the ip of the call to Infinite. */
  client_ip_address?: string
  /** The BUYER'S BROWSER user agent, from the same request. Meta requires it for website events. */
  client_user_agent?: string
}

/** The only keys an adMatch block may carry — anything else is rejected as a malformed envelope. */
export const AD_MATCH_KEYS = [
  "em",
  "fbc",
  "fbp",
  "external_id",
  "client_ip_address",
  "client_user_agent"
] as const

/**
 * The email hash Infinite (and Meta) expect: sha256 hex of the TRIMMED, LOWERCASED address.
 *
 * Meta's normalisation for the `em` parameter. Call it on your server; the address itself never
 * leaves it. Never hash an already-hashed value — that is the single most common way to produce a
 * match key that matches nothing.
 */
export function hashInfiniteEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
}

export interface ServerLaneEvent {
  eventId: string
  eventName: string
  occurredAt: string
  accountKey?: string
  properties: Record<string, string | number | boolean>
  /** OPTIONAL, OUTCOMES ONLY. Consumed by the Meta CAPI relay at ingest, then discarded. */
  adMatch?: InfiniteAdMatch
}

/** The full site_document_request envelope for one document request. */
export function buildDocumentRequestEvent(input: DocumentRequestEventInput): ServerLaneEvent {
  const visitKey = computeVisitKey({
    secret: input.secret,
    clientIp: input.clientIp,
    userAgent: input.userAgent,
    epochSeconds: Math.floor(input.nowMs / 1000)
  })
  const referrerHost = referrerHostOf(input.referrer)
  return {
    eventId: computeDocumentEventId({
      secret: input.secret,
      visitKey,
      path: input.path,
      occurredAtMs: input.nowMs
    }),
    eventName: DOCUMENT_REQUEST_EVENT_NAME,
    occurredAt: new Date(input.nowMs).toISOString(),
    properties: {
      path: input.path,
      host: input.host,
      visitKey,
      userAgentFamily: classifyUserAgent(input.userAgent),
      ...(referrerHost ? { referrerHost } : {})
    }
  }
}

/** The signed request a customer server sends: URL, headers, raw body. Pure — no fetch here. */
export function buildSignedServerEventRequest(input: {
  sourceKey: string
  secret: string
  event: ServerLaneEvent
  destination?: string
}): { url: string; headers: Record<string, string>; body: string } {
  const body = JSON.stringify(input.event)
  return {
    url: input.destination ?? INFINITE_SERVER_EVENTS_DESTINATION,
    headers: {
      "content-type": "application/json",
      [SERVER_LANE_SOURCE_KEY_HEADER]: input.sourceKey,
      [SERVER_LANE_SIGNATURE_HEADER]: signServerEventBody(input.secret, body)
    },
    body
  }
}
