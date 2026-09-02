// Reference implementations for stacks infinite-tag does not patch automatically. Code only —
// every sentence of prose lives in copy.ts. Contract values are interpolated from helpers.ts and
// workspace-artifacts.ts so the snippets can never disagree with the Node recipe.
import { INFINITE_SERVER_EVENTS_DESTINATION } from "../workspace-artifacts.js"

import {
  AUTOMATION_USER_AGENT_PATTERN,
  DOCUMENT_EVENT_ID_PREFIX,
  DOCUMENT_REQUEST_EVENT_NAME,
  NON_DOCUMENT_PATH_PREFIXES,
  REFERRER_HOST_PATTERN,
  SERVER_LANE_DELIVERY_TIMEOUT_MS,
  SERVER_LANE_SECRET_ENV,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_ENV,
  SERVER_LANE_SOURCE_KEY_HEADER,
  VISIT_BUCKET_SECONDS,
  VISIT_KEY_MESSAGE_PREFIX
} from "./helpers.js"

const prefixes = JSON.stringify([...NON_DOCUMENT_PATH_PREFIXES])
const automation = `/${AUTOMATION_USER_AGENT_PATTERN.source}/i`
const referrerHostPattern = `/${REFERRER_HOST_PATTERN.source}/`
const url = JSON.stringify(INFINITE_SERVER_EVENTS_DESTINATION)
const docEvent = JSON.stringify(DOCUMENT_REQUEST_EVENT_NAME)
const docPrefix = JSON.stringify(DOCUMENT_EVENT_ID_PREFIX)
const visitPrefix = JSON.stringify(VISIT_KEY_MESSAGE_PREFIX)
const sourceHeader = JSON.stringify(SERVER_LANE_SOURCE_KEY_HEADER)
const signatureHeader = JSON.stringify(SERVER_LANE_SIGNATURE_HEADER)
// Snippet import lines live in constants so the package self-containment scanner
// (package-shape.test.ts) never mistakes them for this package's own imports.
const EXPRESS_IMPORT = 'import express from "express"'
const OUTCOME_HELPER_IMPORT = 'import { postInfiniteOutcome } from "../lib/infinite-outcome"'

/** infinite-server-lane.mjs — the generic Node helper (Express, Fastify, Koa, Hono-on-Node, plain http). */
export function nodeHelperSnippet(): string {
  return String.raw`// infinite-server-lane.mjs — generic Node helper. Node >= 18 (global fetch).
import { createHmac, randomUUID } from "node:crypto"

const INFINITE_SERVER_EVENTS_URL = ${url}
const SOURCE_KEY = process.env.${SERVER_LANE_SOURCE_KEY_ENV} ?? ""
const SECRET = process.env.${SERVER_LANE_SECRET_ENV} ?? ""
const DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}
const AUTOMATION_USER_AGENT = ${automation}
const NON_DOCUMENT_PREFIXES = ${prefixes}
const REFERRER_HOST = ${referrerHostPattern}

const hmacHex = (message) => createHmac("sha256", SECRET).update(message, "utf8").digest("hex")

/** Plain lowercase hostname of the Referer, or undefined — never its path or query. */
export function referrerHostOf(referrer) {
  if (!referrer) return undefined
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    return REFERRER_HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/** 30-minute visit key. The IP is hashed here and never sent. */
export function infiniteVisitKey({ clientIp, userAgent, nowMs = Date.now() }) {
  const bucket = Math.floor(Math.floor(nowMs / 1000) / VISIT_BUCKET_SECONDS)
  return hmacHex(${visitPrefix} + (clientIp ?? "") + "|" + (userAgent ?? "") + "|" + bucket)
}

export function classifyUserAgent(userAgent) {
  const value = (userAgent ?? "").trim()
  if (!value) return "unknown"
  return AUTOMATION_USER_AGENT.test(value) ? "automation" : "browser"
}

/** GET + accepts text/html + not a prefetch + not an asset/API/Next-internal path. */
export function isInfiniteDocumentRequest({ method, path, accept, prefetch = false }) {
  if (method !== "GET" || prefetch) return false
  if (!String(accept ?? "").toLowerCase().includes("text/html")) return false
  if (NON_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  return !path.slice(path.lastIndexOf("/") + 1).includes(".")
}

/** The site_document_request envelope for one HTML document request. */
export function buildInfiniteDocumentEvent({ path, host, clientIp, userAgent, referrer, nowMs = Date.now() }) {
  const visitKey = infiniteVisitKey({ clientIp, userAgent, nowMs })
  const referrerHost = referrerHostOf(referrer)
  return {
    eventId: ${docPrefix} + hmacHex(visitKey + "|" + path + "|" + nowMs),
    eventName: ${docEvent},
    occurredAt: new Date(nowMs).toISOString(),
    properties: {
      path,
      host,
      visitKey,
      userAgentFamily: classifyUserAgent(userAgent),
      ...(referrerHost ? { referrerHost } : {})
    }
  }
}

/**
 * Sign and POST one event. Fire-and-forget: call it as 'void sendInfiniteServerEvent(event)' and
 * never await it in the request path. Resolves true on 2xx; never throws.
 */
export function sendInfiniteServerEvent(event) {
  if (!SECRET || !SOURCE_KEY) return Promise.resolve(false)
  const body = JSON.stringify({
    eventId: event.eventId ?? randomUUID(),
    eventName: event.eventName,
    occurredAt: event.occurredAt ?? new Date().toISOString(),
    ...(event.accountKey ? { accountKey: event.accountKey } : {}),
    properties: event.properties ?? {}
  })
  return fetch(INFINITE_SERVER_EVENTS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ${sourceHeader}: SOURCE_KEY,
      ${signatureHeader}: hmacHex(body)
    },
    body,
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
  })
    .then((response) => response.ok)
    .catch(() => false)
}
`
}

/** Express middleware using the Node helper above. */
export function expressSnippet(): string {
  return String.raw`// server.mjs (Express) — mount BEFORE your routes and static handler.
${EXPRESS_IMPORT}
import {
  buildInfiniteDocumentEvent,
  isInfiniteDocumentRequest,
  sendInfiniteServerEvent
} from "./infinite-server-lane.mjs"

const app = express()
app.set("trust proxy", true) // so req.ip / req.hostname reflect the real client behind your proxy

app.use((req, res, next) => {
  try {
    const path = req.path // path only — never the query string
    const prefetch = Boolean(req.headers["purpose"] || req.headers["sec-purpose"])
    if (isInfiniteDocumentRequest({ method: req.method, path, accept: req.headers.accept, prefetch })) {
      const event = buildInfiniteDocumentEvent({
        path,
        host: req.hostname,
        clientIp: req.ip ?? "",
        userAgent: req.headers["user-agent"] ?? "",
        referrer: req.headers.referer
      })
      void sendInfiniteServerEvent(event) // fire-and-forget; never awaited, never throws
    }
  } catch {
    // the lane never affects the response
  }
  next()
})
`
}

/** The WebCrypto twin of the Node helper, for edge runtimes (Cloudflare Workers, Netlify Edge, Deno, Bun). */
export function webCryptoHelperSnippet(): string {
  return String.raw`// infinite-server-lane-edge.js — WebCrypto helper for edge runtimes (no Node imports).
const INFINITE_SERVER_EVENTS_URL = ${url}
const DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}
const AUTOMATION_USER_AGENT = ${automation}
const NON_DOCUMENT_PREFIXES = ${prefixes}
const REFERRER_HOST = ${referrerHostPattern}

export async function hmacHex(secret, message) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function classifyUserAgent(userAgent) {
  const value = (userAgent ?? "").trim()
  if (!value) return "unknown"
  return AUTOMATION_USER_AGENT.test(value) ? "automation" : "browser"
}

/** Plain lowercase hostname of the Referer, or undefined — never its path or query. */
export function referrerHostOf(referrer) {
  if (!referrer) return undefined
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    return REFERRER_HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

export function isInfiniteDocumentRequest(request, path) {
  if (request.method !== "GET") return false
  const purpose = (request.headers.get("purpose") ?? request.headers.get("sec-purpose") ?? "").toLowerCase()
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return false
  if (!(request.headers.get("accept") ?? "").toLowerCase().includes("text/html")) return false
  if (NON_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  return !path.slice(path.lastIndexOf("/") + 1).includes(".")
}

/** Build + sign + POST one site_document_request. Call inside waitUntil; never throws. */
export async function recordInfiniteDocumentRequest({ request, path, host, clientIp, secret, sourceKey, nowMs = Date.now() }) {
  try {
    if (!secret || !sourceKey) return false
    const userAgent = request.headers.get("user-agent") ?? ""
    const bucket = Math.floor(Math.floor(nowMs / 1000) / VISIT_BUCKET_SECONDS)
    const visitKey = await hmacHex(secret, ${visitPrefix} + (clientIp ?? "") + "|" + userAgent + "|" + bucket)
    const referrerHost = referrerHostOf(request.headers.get("referer"))
    const event = {
      eventId: ${docPrefix} + (await hmacHex(secret, visitKey + "|" + path + "|" + nowMs)),
      eventName: ${docEvent},
      occurredAt: new Date(nowMs).toISOString(),
      properties: { path, host, visitKey, userAgentFamily: classifyUserAgent(userAgent), ...(referrerHost ? { referrerHost } : {}) }
    }
    return await sendInfiniteServerEvent({ event, secret, sourceKey })
  } catch {
    return false
  }
}

/** Sign and POST any event (document or outcome). Resolves true on 2xx; never throws. */
export async function sendInfiniteServerEvent({ event, secret, sourceKey }) {
  try {
    const body = JSON.stringify(event)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
    const response = await fetch(INFINITE_SERVER_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json", ${sourceHeader}: sourceKey, ${signatureHeader}: await hmacHex(secret, body) },
      body,
      signal: controller.signal
    }).finally(() => clearTimeout(timer))
    return response.ok
  } catch {
    return false
  }
}
`
}

/** Cloudflare Worker using the WebCrypto helper. */
export function cloudflareWorkerSnippet(): string {
  return String.raw`// worker.js (Cloudflare Workers) — env bindings: ${SERVER_LANE_SECRET_ENV}, ${SERVER_LANE_SOURCE_KEY_ENV}
import { isInfiniteDocumentRequest, recordInfiniteDocumentRequest } from "./infinite-server-lane-edge.js"

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (isInfiniteDocumentRequest(request, url.pathname)) {
      ctx.waitUntil(
        recordInfiniteDocumentRequest({
          request,
          path: url.pathname,
          host: url.hostname,
          clientIp: request.headers.get("cf-connecting-ip") ?? "",
          secret: env.${SERVER_LANE_SECRET_ENV},
          sourceKey: env.${SERVER_LANE_SOURCE_KEY_ENV}
        })
      )
    }
    return fetch(request) // or your existing handler / origin
  }
}
`
}

/** Netlify Edge Function using the WebCrypto helper. */
export function netlifyEdgeSnippet(): string {
  return String.raw`// netlify/edge-functions/infinite-server-lane.js — env: ${SERVER_LANE_SECRET_ENV}, ${SERVER_LANE_SOURCE_KEY_ENV}
import { isInfiniteDocumentRequest, recordInfiniteDocumentRequest } from "../../infinite-server-lane-edge.js"

export default async (request, context) => {
  const url = new URL(request.url)
  if (isInfiniteDocumentRequest(request, url.pathname)) {
    context.waitUntil(
      recordInfiniteDocumentRequest({
        request,
        path: url.pathname,
        host: url.hostname,
        clientIp: context.ip ?? "",
        secret: Netlify.env.get(${JSON.stringify(SERVER_LANE_SECRET_ENV)}),
        sourceKey: Netlify.env.get(${JSON.stringify(SERVER_LANE_SOURCE_KEY_ENV)})
      })
    )
  }
  return context.next()
}

export const config = { path: "/*", excludedPath: ["/api/*", "/_next/*", "/*.*"] }
`
}

/** Reporting an outcome from a Node backend (route handler, webhook, job). */
export function outcomeSnippet(): string {
  return String.raw`// Anywhere on your server, after the outcome is REAL (row committed, payment captured, file served):
import { infiniteVisitKey, sendInfiniteServerEvent } from "./infinite-server-lane.mjs"

void sendInfiniteServerEvent({
  eventName: "sign_up",                     // the exact name from Infinite → Conversions
  eventId: "signup:" + user.id,             // stable per outcome, so retries dedupe
  accountKey: user.id,                      // optional; for account-deduped outcomes (hashed at rest)
  properties: {
    visitKey: infiniteVisitKey({ clientIp: req.ip, userAgent: req.headers["user-agent"] }) // same-lane attribution
  }
})
`
}

/**
 * Reporting an outcome from a serverless route with the generated `lib/infinite-outcome` helper —
 * the three lines a Vercel `api/` function needs.
 */
export function outcomeRouteSnippet(): string {
  return String.raw`// api/checkout-status.ts — a Vercel serverless function confirming a paid session.
${OUTCOME_HELPER_IMPORT}

export default async function handler(request: Request): Promise<Response> {
  const session = await stripe.checkout.sessions.retrieve(new URL(request.url).searchParams.get("id"))
  if (session.payment_status !== "paid") return Response.json({ paid: false })

  await postInfiniteOutcome({
    type: "purchase",              // the exact name from Infinite -> Conversions
    path: "/checkout",             // pathname only
    eventId: "purchase:" + session.id, // stable, so a retry dedupes
    accountKey: session.customer,  // optional; hashed at rest by Infinite
    visitKeyInputs: request        // same visitKey as the page view -> same-lane conversion rate
  })

  return Response.json({ paid: true })
}
`
}

/** Reporting an outcome from Next.js with the managed module. */
export function nextOutcomeSnippet(moduleImportPath: string): string {
  return String.raw`// app/api/signup/route.ts (or a server action / webhook) — after the outcome is REAL:
import { sendInfiniteServerEvent } from ${JSON.stringify(moduleImportPath)}

export async function POST(request: Request) {
  const user = await createUser(await request.json())
  void sendInfiniteServerEvent({
    eventName: "sign_up",          // the exact name from Infinite → Conversions
    eventId: "signup:" + user.id,  // stable per outcome, so retries dedupe
    accountKey: user.id,           // optional; account-deduped outcomes
    request                        // carries the same visitKey as the page view
  })
  return Response.json({ ok: true })
}
`
}

/** The exact fenced lines to add to a middleware infinite-tag could not patch. */
export function manualNextMiddlewareAddition(input: { moduleImportPath: string; matcher: string }): string {
  return String.raw`// 1. Top of your middleware.ts / proxy.ts:
// infinite-tag:server-lane:start
import { withInfiniteServerLane } from ${JSON.stringify(input.moduleImportPath)}
// infinite-tag:server-lane:end

// 2. Stop exporting your handler directly (keep its body unchanged) …
async function middleware(request: NextRequest, event: NextFetchEvent) {
  // your existing logic — scope it by request.nextUrl.pathname if it must only run on some routes
  return NextResponse.next()
}

// 3. … and export the wrapped handler instead:
// infinite-tag:server-lane:start
export default withInfiniteServerLane(middleware)
// infinite-tag:server-lane:end

// 4. The matcher must let every HTML document through (skip your own logic by path inside the handler):
export const config = {
  matcher: [${JSON.stringify(input.matcher)}]
}
`
}
