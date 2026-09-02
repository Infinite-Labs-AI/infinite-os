// The generated Next.js server-lane code, as source text.
//
// Two files ship into a Next.js project:
//   1. lib/infinite-server-lane.ts — the managed module (WebCrypto, Edge-safe): the document
//      request recorder, the middleware wrapper, and the outcome sender.
//   2. middleware.ts (or proxy.ts / src/…) — created when absent, or patched with a fenced block
//      that wraps the customer's existing middleware. See middleware-patch.ts.
//
// Everything that is a contract value (URL, header names, env names, bucket size, bot list, skip
// prefixes) is interpolated from helpers.ts / workspace-artifacts.ts so it cannot drift from the
// Node recipe; runtime-source.test.ts executes this generated module against the same vectors.
import { managedFileBanner } from "../frameworks/managed-files.js"
import { infiniteServerEventsDestination } from "../workspace-artifacts.js"

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

export const SERVER_LANE_FENCE_START = "// infinite-tag:server-lane:start"
export const SERVER_LANE_FENCE_END = "// infinite-tag:server-lane:end"

/** The standard Next.js matcher: every route except Next internals, favicon, API routes, and files. */
export const NEXT_DOCUMENT_MATCHER = "/((?!_next/static|_next/image|favicon.ico|api|.*\\..*).*)"

export const SERVER_LANE_MODULE_BASENAME = "infinite-server-lane"
export const SERVER_LANE_WRAPPER_EXPORT = "withInfiniteServerLane"

// Generated-code import lines live in constants so the package self-containment scanner
// (package-shape.test.ts) never mistakes them for this package's own imports.
const NEXT_SERVER_IMPORTS = [
  'import { NextResponse } from "next/server"',
  'import type { NextFetchEvent, NextRequest } from "next/server"'
].join("\n")

export interface ServerLaneModuleInput {
  /** Public site source key baked as the env fallback (the pixel already ships it to browsers). Empty = env only. */
  siteSourceKey?: string
  /** Verified production hosts; when non-empty the lane is dormant on every other host. */
  productionHosts?: string[]
  /**
   * The resolved `--infinite-api-origin`. Absent (the normal case) the module is byte-identical to
   * every earlier install; set, the server lane follows the browser lane to the same host.
   */
  apiOrigin?: string
}

function jsStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

/** lib/infinite-server-lane.ts — the managed module. Edge-runtime safe: WebCrypto only, no Node imports. */
export function buildServerLaneModuleSource(input: ServerLaneModuleInput = {}): string {
  const bakedSourceKey = JSON.stringify(input.siteSourceKey ?? "")
  const bakedHosts = jsStringArray(
    (input.productionHosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean)
  )
  return String.raw`${managedFileBanner}
// Infinite server lane — lossless document + outcome analytics.
// Secrets come from the environment only; infinite-tag never writes them here.
//   ${SERVER_LANE_SECRET_ENV}  the source's server-event secret (Infinite → Site Analytics → Settings → Conversions → Server events)
//   ${SERVER_LANE_SOURCE_KEY_ENV}      the public site source key (falls back to the value baked below)
${SERVER_LANE_FENCE_START}
${NEXT_SERVER_IMPORTS}

const INFINITE_SERVER_EVENTS_URL = ${JSON.stringify(infiniteServerEventsDestination(input.apiOrigin))}
const SOURCE_KEY = process.env.${SERVER_LANE_SOURCE_KEY_ENV} || ${bakedSourceKey}
const PRODUCTION_HOSTS: string[] = ${bakedHosts}
const DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}
const DOCUMENT_EVENT_NAME = ${JSON.stringify(DOCUMENT_REQUEST_EVENT_NAME)}
const AUTOMATION_USER_AGENT = /${AUTOMATION_USER_AGENT_PATTERN.source}/i
const NON_DOCUMENT_PREFIXES = ${jsStringArray([...NON_DOCUMENT_PATH_PREFIXES])}
const REFERRER_HOST = /${REFERRER_HOST_PATTERN.source}/

type MiddlewareLike = (request: NextRequest, event: NextFetchEvent) => unknown
type WaitUntilLike = { waitUntil?: (promise: Promise<unknown>) => void } | undefined

export interface InfiniteServerEventInput {
  /** The exact outcome name from Infinite → Conversions (e.g. "sign_up", "purchase", "download"). */
  eventName: string
  /** Stable per-outcome id (order id, signup id) so retries dedupe. Defaults to a random UUID. */
  eventId?: string
  occurredAt?: Date
  /** Opaque account identifier for account-deduped outcomes; hashed at rest by Infinite. */
  accountKey?: string
  properties?: Record<string, string | number | boolean>
  /**
   * OPTIONAL ad-match block, for founders who run Meta ads and have no PostHog. When the relay is
   * on in Infinite, this outcome is forwarded to Meta's Conversions API and the block is then
   * DISCARDED - never stored. YOUR server hashes: em and external_id are sha256 hex
   * (crypto.subtle / node:crypto), so a raw email never leaves this process. fbc and fbp are
   * Meta's own first-party cookies on your domain.
   */
  adMatch?: { em?: string; fbc?: string; fbp?: string; external_id?: string }
  /** Pass the incoming request (or its headers) so the outcome carries the same visitKey as the page view. */
  request?: { headers: Headers }
}

/**
 * Wrap a Next.js middleware (or none) so every HTML document request is recorded before the
 * wrapped handler runs. Recording is fire-and-forget via event.waitUntil and can never throw
 * into the request path.
 */
export function ${SERVER_LANE_WRAPPER_EXPORT}<Handler extends MiddlewareLike>(handler?: Handler) {
  return function infiniteServerLaneMiddleware(request: NextRequest, event: NextFetchEvent) {
    recordInfiniteDocumentRequest(request, event)
    return handler ? handler(request, event) : NextResponse.next()
  }
}

/** Record one document request. Safe to call from any middleware; skips assets, APIs, non-GETs, prefetches. */
export function recordInfiniteDocumentRequest(request: NextRequest, event?: WaitUntilLike): void {
  try {
    const secret = process.env.${SERVER_LANE_SECRET_ENV}
    if (!secret || !SOURCE_KEY) return
    if (!isDocumentRequest(request)) return
    const host = requestHost(request)
    if (!hostAllowed(host)) return
    const task = sendDocumentRequest(request, secret, host).catch(() => undefined)
    if (event && typeof event.waitUntil === "function") event.waitUntil(task)
  } catch {
    // The lane never affects the response.
  }
}

/**
 * Report an outcome (sign-up completed, purchase, download served) from a route handler, server
 * action, or webhook. Resolves true when Infinite acknowledged it; never throws.
 */
export async function sendInfiniteServerEvent(input: InfiniteServerEventInput): Promise<boolean> {
  try {
    const secret = process.env.${SERVER_LANE_SECRET_ENV}
    if (!secret || !SOURCE_KEY) return false
    const properties: Record<string, string | number | boolean> = { ...(input.properties ?? {}) }
    if (input.request && properties.visitKey === undefined) {
      const visitKey = await infiniteVisitKey(input.request.headers, secret)
      if (visitKey) properties.visitKey = visitKey
    }
    const event = {
      eventId: input.eventId ?? crypto.randomUUID(),
      eventName: input.eventName,
      occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      ...(input.accountKey ? { accountKey: input.accountKey } : {}),
      properties,
      // Inside the SIGNED body: nobody without the secret can inject a match block.
      ...(input.adMatch ? { adMatch: input.adMatch } : {})
    }
    return await postSigned(secret, JSON.stringify(event))
  } catch {
    return false
  }
}

/** The 30-minute visit key for a request: HMAC(secret, "visit:" + ip + "|" + ua + "|" + bucket). The IP never leaves this server. */
export async function infiniteVisitKey(
  headers: Headers,
  secret: string = process.env.${SERVER_LANE_SECRET_ENV} ?? "",
  nowMs: number = Date.now()
): Promise<string | null> {
  if (!secret) return null
  const clientIp = clientIpFrom(headers)
  const userAgent = headers.get("user-agent") ?? ""
  const bucket = Math.floor(Math.floor(nowMs / 1000) / VISIT_BUCKET_SECONDS)
  return hmacHex(secret, ${JSON.stringify(VISIT_KEY_MESSAGE_PREFIX)} + clientIp + "|" + userAgent + "|" + bucket)
}

async function sendDocumentRequest(request: NextRequest, secret: string, host: string): Promise<void> {
  const nowMs = Date.now()
  const path = request.nextUrl.pathname
  const userAgent = request.headers.get("user-agent") ?? ""
  const visitKey = (await infiniteVisitKey(request.headers, secret, nowMs)) as string
  const eventId = ${JSON.stringify(DOCUMENT_EVENT_ID_PREFIX)} + (await hmacHex(secret, visitKey + "|" + path + "|" + nowMs))
  const referrerHost = referrerHostOf(request.headers.get("referer"))
  const event = {
    eventId,
    eventName: DOCUMENT_EVENT_NAME,
    occurredAt: new Date(nowMs).toISOString(),
    properties: {
      path,
      host,
      visitKey,
      userAgentFamily: classifyUserAgent(userAgent),
      ...(referrerHost ? { referrerHost } : {})
    }
  }
  await postSigned(secret, JSON.stringify(event))
}

async function postSigned(secret: string, body: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS)
  try {
    const response = await fetch(INFINITE_SERVER_EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ${JSON.stringify(SERVER_LANE_SOURCE_KEY_HEADER)}: SOURCE_KEY,
        ${JSON.stringify(SERVER_LANE_SIGNATURE_HEADER)}: await hmacHex(secret, body)
      },
      body,
      signal: controller.signal,
      keepalive: true
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

function isDocumentRequest(request: NextRequest): boolean {
  if (request.method !== "GET") return false
  const headers = request.headers
  const purpose = (headers.get("purpose") ?? headers.get("sec-purpose") ?? "").toLowerCase()
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return false
  if (headers.get("next-router-prefetch") || headers.get("x-middleware-prefetch")) return false
  // Honor Do-Not-Track / Global-Privacy-Control, like the client pixel does.
  if (headers.get("dnt") === "1" || headers.get("sec-gpc") === "1") return false
  const accept = (headers.get("accept") ?? "").toLowerCase()
  if (!accept.includes("text/html")) return false
  const path = request.nextUrl.pathname
  if (NON_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  const lastSegment = path.slice(path.lastIndexOf("/") + 1)
  return !lastSegment.includes(".")
}

function requestHost(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  const raw = forwarded || request.headers.get("host") || request.nextUrl.host || ""
  return raw.toLowerCase().replace(/:\d+$/, "")
}

function hostAllowed(host: string): boolean {
  if (!host) return false
  if (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return false
  }
  return PRODUCTION_HOSTS.length === 0 || PRODUCTION_HOSTS.includes(host)
}

function clientIpFrom(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  if (forwarded) return forwarded
  return headers.get("x-real-ip")?.trim() ?? ""
}

function classifyUserAgent(userAgent: string): "browser" | "automation" | "unknown" {
  const value = userAgent.trim()
  if (value.length === 0) return "unknown"
  return AUTOMATION_USER_AGENT.test(value) ? "automation" : "browser"
}

function referrerHostOf(referrer: string | null): string | undefined {
  if (!referrer) return undefined
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    return REFERRER_HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}
${SERVER_LANE_FENCE_END}
`
}

/** The whole middleware file infinite-tag creates when the project has none. */
export function buildCreatedMiddlewareSource(input: { moduleImportPath: string }): string {
  return String.raw`${managedFileBanner}
${SERVER_LANE_FENCE_START}
${wrapperImportLine(input.moduleImportPath)}

// Every HTML document request is recorded server-side (fire-and-forget), then passes through.
export default ${SERVER_LANE_WRAPPER_EXPORT}()

export const config = {
  matcher: [${JSON.stringify(NEXT_DOCUMENT_MATCHER)}]
}
${SERVER_LANE_FENCE_END}
`
}

function wrapperImportLine(moduleImportPath: string): string {
  return `import { ${SERVER_LANE_WRAPPER_EXPORT} } from ${JSON.stringify(moduleImportPath)}`
}

/** The fenced import block inserted at the top of an existing middleware. */
export function buildFencedImportBlock(input: { moduleImportPath: string }): string {
  return [SERVER_LANE_FENCE_START, wrapperImportLine(input.moduleImportPath), SERVER_LANE_FENCE_END, ""].join("\n")
}

/** The fenced export block appended to an existing middleware, wrapping its (now un-exported) handler. */
export function buildFencedExportBlock(input: { innerIdentifier: string }): string {
  return [
    "",
    SERVER_LANE_FENCE_START,
    "// Records every HTML document request server-side, then runs the middleware above unchanged.",
    `export default ${SERVER_LANE_WRAPPER_EXPORT}(${input.innerIdentifier})`,
    SERVER_LANE_FENCE_END,
    ""
  ].join("\n")
}
