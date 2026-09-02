// What every non-Next server-lane target shares: the managed-file planner (create / keep / manual),
// and the generated source text for the web-standard lane core and the outcome helper.
//
// The Next.js target (runtime-source.ts) is deliberately NOT built on this: its generated module
// imports next/server and is pinned byte-for-byte by install.test.ts. Everything here is
// framework-free — Request / Headers / URL / WebCrypto / fetch only — so the same core text runs on
// Vercel's Edge runtime, Netlify's Deno runtime, Cloudflare Workers, and Node >= 18.
//
// Contract values (URL, header names, env names, bucket size, bot list, skip prefixes) are
// interpolated from helpers.ts / workspace-artifacts.ts, exactly as runtime-source.ts and
// snippets.ts do, so no generated file can drift from the Node recipe.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { isManagedInfiniteFile, managedFileBanner } from "../../frameworks/managed-files.js"
import { fileExists } from "../../frameworks/shared.js"
import { computeContentHash } from "../../manifest.js"
import type { InstallManifest, ServerLaneMode } from "../../types.js"
import {
  DEFAULT_INFINITE_COLLECT_PATH,
  infiniteServerEventsDestination
} from "../../workspace-artifacts.js"
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
} from "../helpers.js"
import { SERVER_LANE_FENCE_END, SERVER_LANE_FENCE_START } from "../runtime-source.js"

export type ServerLaneFileAction = "create" | "keep" | "manual"

/** "entry" = the file the host actually runs; "module" = generated code the entry imports. */
export type ServerLaneFileRole = "entry" | "module"

export interface ServerLaneTargetFile {
  /** App-root-relative path. */
  path: string
  role: ServerLaneFileRole
  action: ServerLaneFileAction
  /** Why the file was left alone (action "manual"). */
  reason?: string
}

export interface TargetPlanInput {
  appRootAbsolute: string
  previousManifest: InstallManifest | null
  /** App-relative → root-relative, so manifest ownership lookups line up. */
  toRootRelative: (appRelative: string) => string
}

export interface ServerLaneTargetPlan {
  mode: ServerLaneMode
  files: ServerLaneTargetFile[]
  assumptions: string[]
  blockers: string[]
  /** Packages the generated entry imports that the repo may not depend on yet. */
  installPackages: string[]
}

export interface TargetBuildInput {
  siteSourceKey?: string
  productionHosts: string[]
  /** The Infinite pixel's same-origin collect path, excluded from the document lane. */
  collectPath?: string
  /**
   * The resolved `--infinite-api-origin` / `INFINITE_API_ORIGIN`. The generated lane posts here, so
   * an override moves the SERVER lane with the browser lane instead of splitting them across hosts.
   */
  apiOrigin?: string
}

export interface ServerLaneTargetDefinition {
  mode: ServerLaneMode
  /** One line for the CLI: what was chosen. */
  label: string
  /** Files in write order, app-relative. */
  files(appRootAbsolute: string): Array<{ path: string; role: ServerLaneFileRole }>
  /** app-relative path → contents, for every planned file. */
  build(input: TargetBuildInput, appRootAbsolute: string): Record<string, string>
  installPackages: string[]
}

/**
 * Decide create / keep / manual per file, exactly like the Next middleware planner:
 * absent → create; ours and untouched → create (idempotent regenerate); ours but edited → keep
 * (never clobber, and uninstall will refuse); someone else's file → manual for an entry (the brief
 * carries the exact addition) or a blocker for a generated module (we would have to overwrite it).
 */
export function planManagedFiles(
  candidates: Array<{ path: string; role: ServerLaneFileRole }>,
  input: TargetPlanInput
): { files: ServerLaneTargetFile[]; assumptions: string[]; blockers: string[] } {
  const files: ServerLaneTargetFile[] = []
  const assumptions: string[] = []
  const blockers: string[] = []

  for (const candidate of candidates) {
    if (!fileExists(input.appRootAbsolute, candidate.path)) {
      files.push({ path: candidate.path, role: candidate.role, action: "create" })
      continue
    }

    const source = readFileSync(join(input.appRootAbsolute, candidate.path), "utf8")
    const rootRelative = input.toRootRelative(candidate.path)
    if (!isManagedInfiniteFile(source)) {
      if (candidate.role === "module") {
        blockers.push(
          `Server lane apply will not overwrite an existing unmanaged ${rootRelative} file.`
        )
        files.push({
          path: candidate.path,
          role: candidate.role,
          action: "manual",
          reason: "a file that Infinite does not manage already exists there"
        })
        continue
      }
      files.push({
        path: candidate.path,
        role: candidate.role,
        action: "manual",
        reason: `${rootRelative} already exists and is not managed by Infinite`
      })
      assumptions.push(
        `${rootRelative} is left untouched because Infinite does not manage it; ${SERVER_LANE_BRIEF_POINTER}`
      )
      continue
    }

    const ownership = input.previousManifest?.configOwnership?.[rootRelative]
    if (!ownership || ownership.kind !== "created") {
      // Our banner but not our record: a leftover from an install this manifest never saw. Never
      // adopt it — deleting a file we cannot prove we wrote is exactly the thing we promise not to do.
      files.push({
        path: candidate.path,
        role: candidate.role,
        action: "manual",
        reason: `${rootRelative} carries the Infinite banner but this install has no ownership record for it`
      })
      assumptions.push(
        `${rootRelative} is left as is: it looks Infinite-managed but no ownership record covers it, so uninstall would not be able to prove it is safe to remove.`
      )
      continue
    }

    if (ownership.installedHash === computeContentHash(source)) {
      files.push({ path: candidate.path, role: candidate.role, action: "create" })
      continue
    }

    files.push({ path: candidate.path, role: candidate.role, action: "keep" })
    assumptions.push(
      `${rootRelative} was edited after infinite-tag created it; it is left as is and uninstall will refuse to remove it automatically.`
    )
  }

  return { files, assumptions, blockers }
}

/**
 * The app-relative directories that do not exist yet but would have to, for `appRelativePath` to be
 * written — shallowest first. Called BEFORE the write, so uninstall can prune exactly what the lane
 * created and nothing the customer already had.
 */
export function missingAncestorDirectories(appRootAbsolute: string, appRelativePath: string): string[] {
  const segments = appRelativePath.split("/").slice(0, -1)
  const missing: string[] = []
  let current = ""
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`
    if (!existsSync(join(appRootAbsolute, current))) missing.push(current)
  }
  return missing
}

const SERVER_LANE_BRIEF_POINTER = "the brief carries the exact code to add by hand."

function jsStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`
}

/** The skip list the generated lane uses: the shared non-document prefixes plus the pixel's collect path. */
export function nonDocumentPrefixes(collectPath?: string): string[] {
  const prefixes: string[] = [...NON_DOCUMENT_PATH_PREFIXES]
  const collect = (collectPath ?? DEFAULT_INFINITE_COLLECT_PATH).trim()
  if (collect.startsWith("/") && !prefixes.some((prefix) => collect.startsWith(prefix))) {
    prefixes.push(collect)
  }
  return prefixes
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * The Vercel `config.matcher` pattern: every path EXCEPT API routes, framework and platform
 * internals, the pixel's collect path, and anything with a file extension.
 *
 * Vercel docs, Routing Middleware API: "export const config = { matcher: [...] }" is the config
 * export for middleware, and the framework=other samples use it, so it is not Next-only.
 * https://vercel.com/docs/routing-middleware/api
 */
export function documentMatcherPattern(collectPath?: string): string {
  const alternatives = nonDocumentPrefixes(collectPath)
    .map((prefix) => escapeForRegExp(prefix.replace(/^\//, "")))
    .join("|")
  return `/((?!${alternatives}|.*\\..*).*)`
}

export interface EdgeCoreInput extends TargetBuildInput {
  /** Export the core's functions (a separate module) or keep them file-local (a self-contained entry). */
  exported: boolean
}

/**
 * The web-standard lane core, as source text.
 *
 * No imports at all — Request, Headers, URL, crypto.subtle, fetch and AbortController only — so the
 * same text compiles on Vercel's Edge runtime, Netlify's Deno runtime and Cloudflare Workers. The
 * caller supplies `secret` and `sourceKey`, because each host exposes environment variables
 * differently (process.env / Netlify.env.get / context.env) and only the entry file should know how.
 */
export function edgeLaneCoreSource(input: EdgeCoreInput): string {
  const exported = input.exported ? "export " : ""
  const bakedSourceKey = JSON.stringify(input.siteSourceKey ?? "")
  const bakedHosts = jsStringArray(
    input.productionHosts.map((host) => host.trim().toLowerCase()).filter(Boolean)
  )
  return String.raw`const INFINITE_SERVER_EVENTS_URL = ${JSON.stringify(infiniteServerEventsDestination(input.apiOrigin))}
const INFINITE_SOURCE_KEY_FALLBACK = ${bakedSourceKey}
const INFINITE_PRODUCTION_HOSTS: string[] = ${bakedHosts}
const INFINITE_DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const INFINITE_VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}
const INFINITE_DOCUMENT_EVENT_NAME = ${JSON.stringify(DOCUMENT_REQUEST_EVENT_NAME)}
const INFINITE_AUTOMATION_USER_AGENT = /${AUTOMATION_USER_AGENT_PATTERN.source}/i
const INFINITE_NON_DOCUMENT_PREFIXES = ${jsStringArray(nonDocumentPrefixes(input.collectPath))}
const INFINITE_REFERRER_HOST = /${REFERRER_HOST_PATTERN.source}/

${exported}interface InfiniteAdMatch {
  /** sha256 hex of the lowercased, trimmed email — hashed by YOUR server, never by Infinite. */
  em?: string
  /** Meta's own _fbc first-party cookie on your domain, verbatim. */
  fbc?: string
  /** Meta's own _fbp first-party cookie on your domain, verbatim. */
  fbp?: string
  /** sha256 hex of your own account id. */
  external_id?: string
}

${exported}interface InfiniteServerEvent {
  eventId?: string
  eventName: string
  occurredAt?: string
  /** Opaque account or order id; Infinite hashes it at rest. */
  accountKey?: string
  properties?: Record<string, string | number | boolean>
  /** OUTCOMES ONLY. Forwarded to Meta's Conversions API when you turn the relay on, then discarded. */
  adMatch?: InfiniteAdMatch
}

${exported}interface InfiniteLaneCredentials {
  /** ${SERVER_LANE_SECRET_ENV} — never written to a file by infinite-tag. */
  secret: string
  /** ${SERVER_LANE_SOURCE_KEY_ENV}; falls back to the public key baked in above. */
  sourceKey?: string
  /** The client IP when the host hands it over directly (Netlify context.ip, Cloudflare cf-connecting-ip). */
  clientIp?: string
}

async function infiniteHmacHex(secret: string, message: string): Promise<string> {
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

function infiniteClassifyUserAgent(userAgent: string): "browser" | "automation" | "unknown" {
  const value = userAgent.trim()
  if (value.length === 0) return "unknown"
  return INFINITE_AUTOMATION_USER_AGENT.test(value) ? "automation" : "browser"
}

/** Plain lowercase hostname of the Referer, or undefined — never its path or query. */
function infiniteReferrerHost(referrer: string | null): string | undefined {
  if (!referrer) return undefined
  try {
    const host = new URL(referrer).hostname.toLowerCase()
    return INFINITE_REFERRER_HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/**
 * First hop of x-forwarded-for, else x-real-ip. Vercel request headers: "x-forwarded-for — The
 * public IP address of the client that made the request"; "x-real-ip — This header is identical to
 * the x-forwarded-for header." https://vercel.com/docs/headers/request-headers
 * The IP is hashed into the visit key on this server and never sent to Infinite.
 */
function infiniteClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
  if (forwarded) return forwarded
  return headers.get("cf-connecting-ip")?.trim() ?? headers.get("x-real-ip")?.trim() ?? ""
}

/** The request host, without a port, preferring the proxy's forwarded host. */
${exported}function infiniteRequestHost(request: Request): string {
  const headers = request.headers
  const forwarded = headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  let raw = forwarded || headers.get("host") || ""
  if (!raw) {
    try {
      raw = new URL(request.url).host
    } catch {
      raw = ""
    }
  }
  return raw.toLowerCase().replace(/:\d+$/, "")
}

/** Loopback and any host outside the verified production list stay dormant. */
${exported}function infiniteHostAllowed(host: string): boolean {
  if (!host) return false
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  ) {
    return false
  }
  return INFINITE_PRODUCTION_HOSTS.length === 0 || INFINITE_PRODUCTION_HOSTS.includes(host)
}

/** GET + accepts text/html + not a prefetch + not an asset, API route, or platform internal. */
${exported}function isInfiniteDocumentRequest(request: Request, path: string): boolean {
  if (request.method !== "GET") return false
  const headers = request.headers
  const purpose = (headers.get("purpose") ?? headers.get("sec-purpose") ?? "").toLowerCase()
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return false
  if (headers.get("next-router-prefetch") || headers.get("x-middleware-prefetch")) return false
  if (!(headers.get("accept") ?? "").toLowerCase().includes("text/html")) return false
  if (INFINITE_NON_DOCUMENT_PREFIXES.some((prefix) => path.startsWith(prefix))) return false
  return !path.slice(path.lastIndexOf("/") + 1).includes(".")
}

/** visitKey = HMAC(secret, "${VISIT_KEY_MESSAGE_PREFIX}" + ip + "|" + userAgent + "|" + 30-minute bucket). */
${exported}async function infiniteVisitKey(
  headers: Headers,
  secret: string,
  nowMs: number = Date.now(),
  clientIp?: string
): Promise<string> {
  const bucket = Math.floor(Math.floor(nowMs / 1000) / INFINITE_VISIT_BUCKET_SECONDS)
  const message =
    ${JSON.stringify(VISIT_KEY_MESSAGE_PREFIX)} +
    (clientIp || infiniteClientIp(headers)) +
    "|" +
    (headers.get("user-agent") ?? "") +
    "|" +
    bucket
  return infiniteHmacHex(secret, message)
}

/** Sign and POST one event. Resolves true on 2xx; never throws. */
${exported}async function sendInfiniteServerEvent(
  event: InfiniteServerEvent,
  credentials: InfiniteLaneCredentials
): Promise<boolean> {
  const sourceKey = credentials.sourceKey || INFINITE_SOURCE_KEY_FALLBACK
  if (!credentials.secret || !sourceKey) return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INFINITE_DELIVERY_TIMEOUT_MS)
  try {
    const body = JSON.stringify({
      eventId: event.eventId ?? crypto.randomUUID(),
      eventName: event.eventName,
      occurredAt: event.occurredAt ?? new Date().toISOString(),
      ...(event.accountKey ? { accountKey: event.accountKey } : {}),
      properties: event.properties ?? {},
      // Inside the SIGNED body, so it cannot be injected without the secret.
      ...(event.adMatch ? { adMatch: event.adMatch } : {})
    })
    const response = await fetch(INFINITE_SERVER_EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ${JSON.stringify(SERVER_LANE_SOURCE_KEY_HEADER)}: sourceKey,
        ${JSON.stringify(SERVER_LANE_SIGNATURE_HEADER)}: await infiniteHmacHex(credentials.secret, body)
      },
      body,
      signal: controller.signal
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Record one HTML document request. Call it inside the host's waitUntil so it never holds the
 * response, and never await it in the request path. Never throws.
 */
${exported}async function recordInfiniteDocumentRequest(
  request: Request,
  credentials: InfiniteLaneCredentials,
  nowMs: number = Date.now()
): Promise<boolean> {
  try {
    const sourceKey = credentials.sourceKey || INFINITE_SOURCE_KEY_FALLBACK
    if (!credentials.secret || !sourceKey) return false
    const host = infiniteRequestHost(request)
    if (!infiniteHostAllowed(host)) return false
    const path = new URL(request.url).pathname
    const userAgent = request.headers.get("user-agent") ?? ""
    const visitKey = await infiniteVisitKey(request.headers, credentials.secret, nowMs, credentials.clientIp)
    const referrerHost = infiniteReferrerHost(request.headers.get("referer"))
    return await sendInfiniteServerEvent(
      {
        eventId:
          ${JSON.stringify(DOCUMENT_EVENT_ID_PREFIX)} +
          (await infiniteHmacHex(credentials.secret, visitKey + "|" + path + "|" + nowMs)),
        eventName: INFINITE_DOCUMENT_EVENT_NAME,
        occurredAt: new Date(nowMs).toISOString(),
        properties: {
          path,
          host,
          visitKey,
          userAgentFamily: infiniteClassifyUserAgent(userAgent),
          ...(referrerHost ? { referrerHost } : {})
        }
      },
      { secret: credentials.secret, sourceKey }
    )
  } catch {
    // The lane never affects the response.
    return false
  }
}`
}

/** A managed file: the Infinite banner, the fence, the body, the closing fence. */
export function managedGeneratedFile(header: string[], body: string): string {
  return [managedFileBanner, ...header, SERVER_LANE_FENCE_START, body, SERVER_LANE_FENCE_END, ""].join("\n")
}

export const OUTCOME_HELPER_EXPORT = "postInfiniteOutcome"

/**
 * lib/infinite-outcome.ts — the outcome poster any server route can import.
 *
 * WebCrypto + fetch only, so the same file works from a Vercel `api/` function (Node >= 18), an
 * edge function, a Netlify function, and a Worker (pass `credentials` there, since Workers hand
 * environment variables to the handler rather than exposing process.env).
 */
export function outcomeHelperSource(input: TargetBuildInput): string {
  const bakedSourceKey = JSON.stringify(input.siteSourceKey ?? "")
  return managedGeneratedFile(
    [
      "// Infinite server lane — report an outcome the moment it becomes REAL (row committed,",
      "// payment captured, file served). Never from a click: a click is intent, not an outcome.",
      "//",
      `//   import { ${OUTCOME_HELPER_EXPORT} } from "../lib/infinite-outcome"`,
      `//   await ${OUTCOME_HELPER_EXPORT}({ type: "purchase", path: "/checkout", accountKey: order.id, visitKeyInputs: request })`,
      "//",
      "// Running Meta ads without PostHog? Add an `adMatch` block and turn the relay on in Infinite",
      "// -> Site -> Settings; the outcome is forwarded to Meta's Conversions API and the match data",
      "// is discarded, never stored. You hash the email, Infinite never sees it.",
      "//",
      `// Secrets come from the environment only: ${SERVER_LANE_SECRET_ENV} + ${SERVER_LANE_SOURCE_KEY_ENV}.`
    ],
    String.raw`const INFINITE_SERVER_EVENTS_URL = ${JSON.stringify(infiniteServerEventsDestination(input.apiOrigin))}
const INFINITE_SOURCE_KEY_FALLBACK = ${bakedSourceKey}
const INFINITE_DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const INFINITE_VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}

export interface InfiniteAdMatch {
  /** sha256 hex of the lowercased, trimmed email. */
  em?: string
  /** Meta's _fbc cookie, verbatim. */
  fbc?: string
  /** Meta's _fbp cookie, verbatim. */
  fbp?: string
  /** sha256 hex of your own account id. */
  external_id?: string
}

export interface InfiniteVisitKeyInputs {
  /** The client IP as your server sees it. Hashed here; it never leaves this process. */
  clientIp?: string
  userAgent?: string
}

export interface InfiniteOutcomeInput {
  /** The exact outcome name from Infinite -> Conversions ("sign_up", "purchase", "download"). */
  type: string
  /** The page path the outcome belongs to (pathname only — no query string). */
  path?: string
  /** Stable per-outcome id (order id, signup id) so retries dedupe. Defaults to a random UUID. */
  eventId?: string
  /** Opaque account or order id; Infinite hashes it at rest. */
  accountKey?: string
  occurredAt?: Date
  /** Up to 16 extra properties: snake_case keys, short token / number / boolean values. */
  properties?: Record<string, string | number | boolean>
  /**
   * OPTIONAL ad-match block — for founders who run Meta ads and have NO PostHog. Turn the relay on
   * in Infinite -> Site -> Settings and an outcome carrying this is forwarded to Meta's Conversions
   * API at ingest, then the block is DISCARDED: Infinite never stores it.
   *
   * YOUR server hashes; Infinite never does. em / external_id are sha256 HEX, so a raw email never
   * leaves this process:
   *
   *   import { createHash } from "node:crypto"
   *   const em = createHash("sha256").update(email.trim().toLowerCase()).digest("hex")
   *
   * fbc / fbp are Meta's own first-party cookies on your domain (the _fbc / _fbp values), which
   * your server can read from the request:
   * https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc
   *
   * Never send a raw email here: a value that is not a 64-character hex digest is rejected with a
   * 400 rather than forwarded.
   */
  adMatch?: InfiniteAdMatch
  /**
   * Same-lane attribution: the incoming request (or its headers, or the raw ip + user agent) so the
   * outcome carries the same visitKey as the page view that produced it.
   */
  visitKeyInputs?: InfiniteVisitKeyInputs | { headers: Headers }
  /** Runtimes without process.env (Cloudflare Workers) pass the values from their own env here. */
  credentials?: { secret?: string; sourceKey?: string }
}

function infiniteEnv(name: string): string {
  const scope = globalThis as {
    process?: { env?: Record<string, string | undefined> }
    Netlify?: { env?: { get(name: string): string | undefined } }
    Deno?: { env?: { get(name: string): string | undefined } }
  }
  return scope.process?.env?.[name] ?? scope.Netlify?.env?.get(name) ?? scope.Deno?.env?.get(name) ?? ""
}

async function infiniteHmacHex(secret: string, message: string): Promise<string> {
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

function infiniteVisitKeyInputsOf(
  input: InfiniteOutcomeInput["visitKeyInputs"]
): InfiniteVisitKeyInputs | null {
  if (!input) return null
  if ("headers" in input && input.headers) {
    const headers = input.headers
    const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    return {
      clientIp: forwarded || headers.get("cf-connecting-ip")?.trim() || headers.get("x-real-ip")?.trim() || "",
      userAgent: headers.get("user-agent") ?? ""
    }
  }
  return input as InfiniteVisitKeyInputs
}

/**
 * Sign and POST one outcome. Resolves true when Infinite acknowledged it; never throws, so a
 * failed report can never fail the checkout, sign-up, or download it describes.
 */
export async function ${OUTCOME_HELPER_EXPORT}(input: InfiniteOutcomeInput): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), INFINITE_DELIVERY_TIMEOUT_MS)
  try {
    const secret = input.credentials?.secret || infiniteEnv(${JSON.stringify(SERVER_LANE_SECRET_ENV)})
    const sourceKey =
      input.credentials?.sourceKey ||
      infiniteEnv(${JSON.stringify(SERVER_LANE_SOURCE_KEY_ENV)}) ||
      INFINITE_SOURCE_KEY_FALLBACK
    if (!secret || !sourceKey) return false

    // One clock for the whole call: the event time and the visit-key bucket must agree.
    const nowMs = input.occurredAt ? input.occurredAt.getTime() : Date.now()
    const properties: Record<string, string | number | boolean> = { ...(input.properties ?? {}) }
    if (input.path) properties.path = input.path
    const visitInputs = infiniteVisitKeyInputsOf(input.visitKeyInputs)
    if (visitInputs && properties.visitKey === undefined) {
      const bucket = Math.floor(Math.floor(nowMs / 1000) / INFINITE_VISIT_BUCKET_SECONDS)
      properties.visitKey = await infiniteHmacHex(
        secret,
        ${JSON.stringify(VISIT_KEY_MESSAGE_PREFIX)} +
          (visitInputs.clientIp ?? "") +
          "|" +
          (visitInputs.userAgent ?? "") +
          "|" +
          bucket
      )
    }

    const body = JSON.stringify({
      eventId: input.eventId ?? crypto.randomUUID(),
      eventName: input.type,
      occurredAt: new Date(nowMs).toISOString(),
      ...(input.accountKey ? { accountKey: input.accountKey } : {}),
      properties,
      // Signed with everything else, so a match block cannot be injected by a third party.
      ...(input.adMatch ? { adMatch: input.adMatch } : {})
    })
    const response = await fetch(INFINITE_SERVER_EVENTS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ${JSON.stringify(SERVER_LANE_SOURCE_KEY_HEADER)}: sourceKey,
        ${JSON.stringify(SERVER_LANE_SIGNATURE_HEADER)}: await infiniteHmacHex(secret, body)
      },
      body,
      signal: controller.signal
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}`
  )
}

export { SERVER_LANE_FENCE_END, SERVER_LANE_FENCE_START }
