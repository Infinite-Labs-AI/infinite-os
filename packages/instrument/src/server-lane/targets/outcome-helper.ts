// The ONE outcome helper every server-lane target ships (Next.js, Vercel, Netlify, Cloudflare Pages,
// Node, and the brief-only fallback): `lib/infinite-outcome.<ts|js|mjs>`.
//
// It is the generic form of what the first store customer's hand-built fix does (its infinite.ts +
// meta-match.ts adapters, its checkout route and its Stripe webhook), with no customer specifics:
//
//   reportInfiniteOutcome(outcome)              → Infinite's HTTP status, or null when nothing was sent
//   reportInfiniteOutcomeForMirror(outcome)     → { status, accepted, duplicate, metaEventId, metaEventName }
//   reportInfiniteOutcomeInBackground(outcome)  → visitor-facing routes: never holds the response long
//   adMatchFromRequest(req, { trackingAllowed, person? }) / personMatch(adMatch, person)
//   buyerContext(req, { trackingAllowed }) → contextMetadata(...) → contextFromMetadata(metadata)
//   stripeCheckoutPayer(session), stripeAmountToMajor(amount, currency), infiniteContentIds(ids),
//   infiniteLeadId(email), infinitePagePath(req, fallback), infiniteConfigured()
//   + Meta's normalizers and hashers, byte for byte the same as Infinite's own (hashing.ts).
//
// WebCrypto + fetch only, so the same text runs on Node >= 20, Vercel functions (Node or Edge),
// Netlify functions, Cloudflare Workers and Deno. The only import is the background primitive the
// site ALREADY has (`waitUntil` from @vercel/functions, or Next's `after`); with neither, a visitor-facing
// report is a bounded 800 ms wait. infinite-tag never adds a dependency for it.
//
// The `.ts` text must pass `tsc --strict` (outcome-helper.test.ts compiles it); the `.js` / `.mjs` text
// is the same source with every type-only span removed, so the two can never behave differently.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { hasDependency, readWorkspacePackageJson } from "../../frameworks/shared.js"
import { infiniteServerEventsDestination } from "../../workspace-artifacts.js"
import {
  SERVER_LANE_DELIVERY_TIMEOUT_MS,
  SERVER_LANE_SECRET_ENV,
  SERVER_LANE_SIGNATURE_HEADER,
  SERVER_LANE_SOURCE_KEY_ENV,
  SERVER_LANE_SOURCE_KEY_HEADER,
  VISIT_BUCKET_SECONDS,
  VISIT_KEY_MESSAGE_PREFIX
} from "../helpers.js"

import {
  managedGeneratedFile,
  outcomeHelperTarget,
  type OutcomeHelperLanguage,
  type OutcomeHelperTarget,
  type TargetBuildInput
} from "./shared.js"

export const OUTCOME_REPORT_EXPORT = "reportInfiniteOutcome"
export const OUTCOME_MIRROR_EXPORT = "reportInfiniteOutcomeForMirror"
export const OUTCOME_BACKGROUND_EXPORT = "reportInfiniteOutcomeInBackground"

/** The site-only secret that keys a person's stable id (lead + purchase share it). Never Infinite's. */
export const LEAD_ID_SECRET_ENV = "LEAD_ID_SECRET"

/** How long a visitor-facing route waits for a report when the site has no background primitive. */
export const OUTCOME_BACKGROUND_WAIT_MS = 800

/** Stripe refuses a metadata value longer than this. */
export const STRIPE_METADATA_VALUE_MAX = 500

/**
 * Stripe's zero-decimal currencies: the amount IS the major unit (¥500 is `500`, not `5.00`).
 * https://docs.stripe.com/currencies#zero-decimal
 */
export const STRIPE_ZERO_DECIMAL_CURRENCIES = [
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"
] as const

/** Stripe's three-decimal currencies: the amount is in thousandths. https://docs.stripe.com/currencies#three-decimal */
export const STRIPE_THREE_DECIMAL_CURRENCIES = ["bhd", "jod", "kwd", "omr", "tnd"] as const

/**
 * Where a visitor-facing report runs after the response, decided from what the site ALREADY has:
 * - `vercel-wait-until`: the site depends on @vercel/functions → `waitUntil(task)`.
 * - `next-after`: a Next.js App Router site on Next >= 15.1 → `after(() => task)` (falls back to the
 *   bounded wait where Next refuses it, e.g. a Pages Router API route).
 * - `bounded`: neither → the route awaits the report for at most 800 ms.
 */
export type OutcomeBackgroundMode = "vercel-wait-until" | "next-after" | "bounded"

// Generated import lines live in constants so the package self-containment scanner
// (package-shape.test.ts) never mistakes them for this package's own imports.
const VERCEL_WAIT_UNTIL_IMPORT = 'import { waitUntil } from "@vercel/functions"'
const NEXT_AFTER_IMPORT = 'import { after } from "next/server"'

function nextMajorMinor(spec: string | undefined): [number, number] | null {
  if (!spec) return null
  const match = /(\d+)\.(\d+)/.exec(spec) ?? /(\d+)/.exec(spec)
  if (!match) return null
  return [Number(match[1]), Number(match[2] ?? 0)]
}

/** The background primitive this site already has; never one it would have to install. */
export function detectOutcomeBackgroundMode(appRootAbsolute: string): OutcomeBackgroundMode {
  if (hasDependency(appRootAbsolute, "@vercel/functions")) return "vercel-wait-until"
  const packageJson = readWorkspacePackageJson(appRootAbsolute)
  const version = nextMajorMinor(packageJson?.dependencies?.next ?? packageJson?.devDependencies?.next)
  const appRouter = ["app", "src/app"].some((dir) => existsSync(join(appRootAbsolute, dir)))
  if (version && appRouter && (version[0] > 15 || (version[0] === 15 && version[1] >= 1))) return "next-after"
  return "bounded"
}

export interface OutcomeHelperOptions {
  language?: OutcomeHelperLanguage
  extension?: OutcomeHelperTarget["extension"]
  background?: OutcomeBackgroundMode
}

/** The language, extension and background mode for this site, in one call (every target uses it). */
export function outcomeHelperOptionsFor(appRootAbsolute: string, basename?: string): OutcomeHelperOptions & { path: string } {
  const target = outcomeHelperTarget(appRootAbsolute, basename)
  return {
    path: target.path,
    language: target.language,
    extension: target.extension,
    background: detectOutcomeBackgroundMode(appRootAbsolute)
  }
}

/** Read a generated helper's background mode back from its text (tests and the brief use it). */
export function outcomeBackgroundModeOf(source: string): OutcomeBackgroundMode {
  if (source.includes(VERCEL_WAIT_UNTIL_IMPORT)) return "vercel-wait-until"
  if (source.includes(NEXT_AFTER_IMPORT)) return "next-after"
  return "bounded"
}

function backgroundBlock(mode: OutcomeBackgroundMode, t: (text: string) => string): string {
  const head = `/**
 * Report an outcome from a route the VISITOR is waiting on (a checkout redirect, a sign-up or lead
 * form) without making them wait on Infinite. ${
    mode === "vercel-wait-until"
      ? "The send is handed to Vercel's waitUntil (this site already depends on @vercel/functions), so the\n * response goes out at once and the function stays alive until the send finishes."
      : mode === "next-after"
        ? "The send is handed to Next's after(), so the response goes out at once. Where Next refuses after()\n * (a Pages Router API route), the route waits for the send for at most 800 ms instead."
        : "This site has no background primitive (no @vercel/functions, no Next after()), so the route waits for\n * the send for at most 800 ms and then answers whatever happened; the send itself is never cut short."
  }
 * Never throws and never rejects.
 */
export async function ${OUTCOME_BACKGROUND_EXPORT}(outcome${t(": InfiniteOutcome")})${t(": Promise<void>")} {
  const task = infiniteSend(outcome)`
  const handOff =
    mode === "vercel-wait-until"
      ? `
  try {
    waitUntil(task)
    return
  } catch {
    // Not inside a Vercel request: the bounded wait below.
  }`
      : mode === "next-after"
        ? `
  try {
    after(() => task)
    return
  } catch {
    // after() outside an App Router request scope throws: the bounded wait below.
  }`
        : ""
  return `${head}${handOff}
  await infiniteBoundedWait(task)
}`
}

/**
 * lib/infinite-outcome.<ts|js|mjs> — the outcome helper. `options.background` is decided from the site's
 * own dependencies by `detectOutcomeBackgroundMode`; absent, it is the dependency-free bounded wait.
 */
export function outcomeHelperSource(input: TargetBuildInput, options: OutcomeHelperOptions = {}): string {
  const bakedSourceKey = JSON.stringify(input.siteSourceKey ?? "")
  const ts = (options.language ?? "ts") === "ts"
  const background = options.background ?? "bounded"
  // Type-only text: present in the .ts helper, removed from the .js/.mjs helper so it runs verbatim.
  const t = (typeText: string): string => (ts ? typeText : "")
  const importExample = `../lib/infinite-outcome${ts ? "" : `.${options.extension ?? "js"}`}`
  const importLine =
    background === "vercel-wait-until" ? VERCEL_WAIT_UNTIL_IMPORT : background === "next-after" ? NEXT_AFTER_IMPORT : ""

  const interfaces = String.raw`/** Meta match data. Every customer field is a sha256 hex digest made HERE; never a phone. */
export interface InfiniteAdMatch {
  em?: string
  external_id?: string
  fn?: string
  ln?: string
  ct?: string
  st?: string
  zp?: string
  country?: string
  /** Meta's _fbc / _fbp cookies, verbatim. */
  fbc?: string
  fbp?: string
  /** The BUYER'S BROWSER ip and user agent, from the buyer's own request (never the webhook's). */
  client_ip_address?: string
  client_user_agent?: string
}

/** The person an outcome belongs to, as plain values. Only digests ever leave this file. No phone. */
export interface InfinitePerson {
  email?: string | null
  /** Your stable id for the person (for a lead or a store buyer: infiniteLeadId(email)). Hashed once. */
  externalId?: string | number | null
  /** The full name: the first word is fn, every later word is ln. */
  name?: string | null
  city?: string | null
  state?: string | null
  postcode?: string | null
  country?: string | null
}

/** A request whose headers are a WHATWG Headers (edge, App Router) OR a plain object (Node, Pages Router). */
export interface InfiniteRequestLike {
  headers: Headers | Record<string, string | string[] | undefined>
}

/** Workers have no process.env: pass the two values from the handler's env here. */
export interface InfiniteCredentials {
  secret?: string
  sourceKey?: string
}

export type InfinitePropertyValue = string | number | boolean | null | undefined

export interface InfiniteOutcome {
  /** The exact conversion name declared in Infinite (purchase, begin_checkout, lead, sign_up, ...). */
  type: string
  /**
   * Stable for this outcome (an order, session, subscription or account id; lead:<infiniteLeadId>).
   * Sent as "<type>:<eventId>" unless it already starts with "<type>:", so a retry counts once.
   */
  eventId: string | number
  /**
   * The page the outcome belongs to ("/success"). Infinite records an outcome without one, but Meta
   * needs it (event_source_url): without a path the relay sends nothing to Meta. A query or fragment is
   * cut off; anything else that is not a plain path is dropped.
   */
  path?: string
  /** Up to 16 keys (snake_case); values are numbers, booleans or short tokens with no spaces. */
  properties?: Record<string, InfinitePropertyValue>
  /** Match data for Meta, only when the page said the visitor allowed tracking. */
  adMatch?: InfiniteAdMatch
  /** Opaque account or order id; Infinite hashes it at rest. */
  accountKey?: string
  occurredAt?: Date
  /** The visitor's own request (or { clientIp, userAgent }), for the same visit key as their page views. */
  visitKeyInputs?: InfiniteRequestLike | { clientIp?: string; userAgent?: string }
  /** The page's infiniteCampaign(), passed through your request. Unknown values are dropped. */
  campaign?: { campaignProvenance?: string; browserContext?: string }
  credentials?: InfiniteCredentials
}

/** Infinite's answer. status null = nothing reached Infinite (not configured, network error, timeout). */
export interface InfiniteOutcomeReport {
  status: number | null
  accepted: boolean
  duplicate: boolean
  /** Mirror THIS conversion in the browser under exactly this id (infiniteMetaMirror), or null: do not. */
  metaEventId: string | null
  metaEventName: string | null
}

/** What the buyer's own request tells the webhook later: the visit key and the device match data. */
export interface InfiniteBuyerContext {
  visitKey?: string
  adMatch?: InfiniteAdMatch
}

/** contextFromMetadata's answer: the buyer context, the cart, and whether THIS site made the session. */
export interface InfiniteCheckoutContext extends InfiniteBuyerContext {
  siteCheckout: boolean
  contentIds?: string
  numItems?: number
}

/** The parts of a Stripe Checkout Session the payer is read from (a real Stripe.Checkout.Session fits). */
export interface InfiniteStripeAddress {
  city?: string | null
  state?: string | null
  postal_code?: string | null
  country?: string | null
}

export interface InfiniteStripeSessionLike {
  customer_details?: { email?: string | null; name?: string | null; address?: InfiniteStripeAddress | null } | null
  collected_information?: { shipping_details?: { name?: string | null; address?: InfiniteStripeAddress | null } | null } | null
  shipping_details?: { name?: string | null; address?: InfiniteStripeAddress | null } | null
}

/** A Stripe Checkout Session as the checkout route and the webhook see it (Stripe.Checkout.Session fits). */
export interface InfiniteStripeCheckoutSession extends InfiniteStripeSessionLike {
  id: string
  amount_total?: number | null
  currency?: string | null
  payment_status?: string | null
  metadata?: Record<string, string> | null
}

/** A VERIFIED Stripe event (after stripe.webhooks.constructEvent); Stripe.Event fits. */
export interface InfiniteStripeEventLike {
  type: string
  livemode: boolean
  data: { object: unknown }
}

`

  const body = String.raw`${importLine ? `${importLine}\n\n` : ""}const INFINITE_SERVER_EVENTS_URL = ${JSON.stringify(infiniteServerEventsDestination(input.apiOrigin))}
const INFINITE_SOURCE_KEY_FALLBACK = ${bakedSourceKey}
const INFINITE_DELIVERY_TIMEOUT_MS = ${SERVER_LANE_DELIVERY_TIMEOUT_MS}
const INFINITE_BACKGROUND_WAIT_MS = ${OUTCOME_BACKGROUND_WAIT_MS}
const INFINITE_VISIT_BUCKET_SECONDS = ${VISIT_BUCKET_SECONDS}
const INFINITE_STRIPE_METADATA_MAX = ${STRIPE_METADATA_VALUE_MAX}
/** Infinite's own limits (server-ingest): more properties, or a value outside these, refuses the WHOLE event. */
const INFINITE_MAX_PROPERTIES = 16
const INFINITE_PROPERTY_KEY = /^[a-z][a-z0-9_]{0,63}$/
const INFINITE_PROPERTY_VALUE = /^[\x21-\x7e]{1,120}$/
const INFINITE_PATH = /^\/[\x21-\x7e]{0,119}$/
const INFINITE_VISIT_KEY = /^[a-fA-F0-9]{64}$/
const INFINITE_MAX_CONTENT_IDS = 20
const INFINITE_ZERO_DECIMAL = ${JSON.stringify([...STRIPE_ZERO_DECIMAL_CURRENCIES])}
const INFINITE_THREE_DECIMAL = ${JSON.stringify([...STRIPE_THREE_DECIMAL_CURRENCIES])}
const INFINITE_CAMPAIGN_PROVENANCE = ["tab", "cookie", "none"]
const INFINITE_BROWSER_CONTEXT = ["facebook_app", "instagram_app", "other_in_app", "browser", "unknown"]

${ts ? interfaces : ""}function infiniteEnv(name${t(": string")})${t(": string")} {
  try {
    const scope = globalThis${t(` as {
      process?: { env?: Record<string, string | undefined> }
      Netlify?: { env?: { get?: Map<string, string>["get"] } }
      Deno?: { env?: { get?: Map<string, string>["get"] } }
    }`)}
    return scope.process?.env?.[name] ?? scope.Netlify?.env?.get?.(name) ?? scope.Deno?.env?.get?.(name) ?? ""
  } catch {
    return ""
  }
}

function infiniteSecret(credentials${t("?: InfiniteCredentials")})${t(": string")} {
  return credentials?.secret || infiniteEnv(${JSON.stringify(SERVER_LANE_SECRET_ENV)})
}

function infiniteSourceKey(credentials${t("?: InfiniteCredentials")})${t(": string")} {
  return credentials?.sourceKey || infiniteEnv(${JSON.stringify(SERVER_LANE_SOURCE_KEY_ENV)}) || INFINITE_SOURCE_KEY_FALLBACK
}

/**
 * False until ${SERVER_LANE_SECRET_ENV} (and a site source key) are set: nothing is reported then.
 * A payment webhook answers 200 while this is false, so the provider never retries a report that
 * cannot happen yet.
 */
export function infiniteConfigured(credentials${t("?: InfiniteCredentials")})${t(": boolean")} {
  return Boolean(infiniteSecret(credentials) && infiniteSourceKey(credentials))
}

function infiniteWarn(message${t(": string")})${t(": void")} {
  try {
    console.warn("[infinite] " + message)
  } catch {
    // Logging never affects the outcome.
  }
}

function infiniteHex(bytes${t(": ArrayBuffer")})${t(": string")} {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

async function infiniteHmacHex(secret${t(": string")}, message${t(": string")})${t(": Promise<string>")} {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return infiniteHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)))
}

export async function sha256Hex(value${t(": string")})${t(": Promise<string>")} {
  return infiniteHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
}

// ---- Meta's normalizers: byte for byte Infinite's own (src/lib/attribution/hashing.ts). Never a phone. ----

function splitEmail(value${t(": string")})${t(": { local: string; domain: string } | null")} {
  const at = value.lastIndexOf("@")
  if (at <= 0 || at === value.length - 1) return null
  return { local: value.slice(0, at), domain: value.slice(at + 1) }
}

/** em: trim + lowercase. Null when the result is not shaped like an email. */
export function normalizeEmailForMeta(email${t(": string")})${t(": string | null")} {
  const normalized = email.trim().toLowerCase()
  return splitEmail(normalized) ? normalized : null
}

export async function hashEmailForMeta(email${t(": string")})${t(": Promise<string | null>")} {
  const normalized = normalizeEmailForMeta(email)
  return normalized ? sha256Hex(normalized) : null
}

/** external_id: trimmed only; an id keeps its case. */
export async function hashExternalId(id${t(": string")})${t(": Promise<string | null>")} {
  const trimmed = id.trim()
  return trimmed ? sha256Hex(trimmed) : null
}

/** zp: lowercase, no spaces or hyphens; a US ZIP+4 is cut to five. */
export function normalizeZipForMeta(zip${t(": string")})${t(": string | null")} {
  const compact = zip.replace(/[\s-]+/g, "").toLowerCase()
  if (!compact) return null
  if (/^\d{9}$/.test(compact)) return compact.slice(0, 5)
  return compact.slice(0, 32)
}

/** country: ISO 3166-1 alpha-2, lowercased. */
export function normalizeCountryForMeta(country${t(": string")})${t(": string | null")} {
  const normalized = country.trim().toLowerCase()
  return /^[a-z]{2}$/.test(normalized) ? normalized : null
}

const META_WHITESPACE_AND_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@ [\]^_\x60{|}~\s]+/g
const META_NON_LATIN_ALPHANUMERIC = /[^a-zA-Z0-9]+/g

/** fn / ln: lowercase, no punctuation or whitespace. */
export function normalizeNameForMeta(name${t(": string")})${t(": string | null")} {
  const normalized = name.toLowerCase().replace(META_WHITESPACE_AND_PUNCTUATION, "")
  return normalized ? normalized.slice(0, 64) : null
}

/** ct: lowercase latin alphanumerics, starting with a letter. */
export function normalizeCityForMeta(city${t(": string")})${t(": string | null")} {
  const normalized = city.toLowerCase().replace(META_NON_LATIN_ALPHANUMERIC, "")
  return /^[a-z]/.test(normalized) ? normalized.slice(0, 64) : null
}

const US_STATE_CODES${t(": Record<string, string>")} = {
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

/** st: the 2-letter code in the US (full names mapped); elsewhere lowercase latin alphanumerics. */
export function normalizeStateForMeta(state${t(": string")}, country${t("?: string | null")})${t(": string | null")} {
  const normalized = state.toLowerCase().replace(META_NON_LATIN_ALPHANUMERIC, "")
  if (!normalized) return null
  if (country && normalizeCountryForMeta(country) === "us") {
    if (US_STATE_CODE_SET.has(normalized)) return normalized
    return US_STATE_CODES[normalized] ?? null
  }
  return normalized.slice(0, 64)
}

export async function hashZipForMeta(zip${t(": string")})${t(": Promise<string | null>")} {
  const normalized = normalizeZipForMeta(zip)
  return normalized ? sha256Hex(normalized) : null
}

export async function hashCountryForMeta(country${t(": string")})${t(": Promise<string | null>")} {
  const normalized = normalizeCountryForMeta(country)
  return normalized ? sha256Hex(normalized) : null
}

export async function hashNameForMeta(name${t(": string")})${t(": Promise<string | null>")} {
  const normalized = normalizeNameForMeta(name)
  return normalized ? sha256Hex(normalized) : null
}

export async function hashCityForMeta(city${t(": string")})${t(": Promise<string | null>")} {
  const normalized = normalizeCityForMeta(city)
  return normalized ? sha256Hex(normalized) : null
}

export async function hashStateForMeta(state${t(": string")}, country${t("?: string | null")})${t(": Promise<string | null>")} {
  const normalized = normalizeStateForMeta(state, country)
  return normalized ? sha256Hex(normalized) : null
}

// ---- The buyer's request: headers, cookies, ip, user agent. ----

function infiniteHeaderValue(headers${t(": InfiniteRequestLike[\"headers\"] | null | undefined")}, name${t(": string")})${t(": string")} {
  if (!headers) return ""
  if (typeof (headers${t(" as Headers")}).get === "function") return (headers${t(" as Headers")}).get(name) ?? ""
  const bag = headers${t(" as Record<string, string | string[] | undefined>")}
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

function infiniteClientIpFrom(headers${t(": InfiniteRequestLike[\"headers\"] | null | undefined")})${t(": string")} {
  const forwarded = (infiniteHeaderValue(headers, "x-forwarded-for").split(",")[0] ?? "").trim()
  if (forwarded) return forwarded
  return infiniteHeaderValue(headers, "cf-connecting-ip").trim() || infiniteHeaderValue(headers, "x-real-ip").trim()
}

// Meta's _fbc / _fbp shape (fb.<subdomainIndex>.<creationTimeMs>.<payload>), the same rule Infinite applies.
const INFINITE_FB_COOKIE = /^fb\.[0-9]{1,2}\.[0-9]{1,20}\.[A-Za-z0-9_%.-]{1,512}$/
const INFINITE_USER_AGENT = /^[\x20-\x7e]{1,512}$/
const INFINITE_IP = /^[0-9A-Fa-f:.]{2,45}$/

function infiniteCookieValues(header${t(": string")}, name${t(": string")})${t(": string[]")} {
  const values${t(": string[]")} = []
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index === -1 || part.slice(0, index).trim() !== name) continue
    values.push(part.slice(index + 1).trim())
  }
  return values
}

/** The NEWEST ad click among every _fbc the browser sent (a host-only and a domain cookie can coexist). */
function infiniteNewestFbc(header${t(": string")})${t(": string | undefined")} {
  let newest = ""
  for (const value of infiniteCookieValues(header, "_fbc")) {
    if (!INFINITE_FB_COOKIE.test(value)) continue
    if (!newest || Number(value.split(".")[2]) > Number(newest.split(".")[2])) newest = value
  }
  return newest || undefined
}

/** _fbp is a browser id, not a click: the first listed, kept only with Meta's shape. */
function infiniteFbp(header${t(": string")})${t(": string | undefined")} {
  const first = infiniteCookieValues(header, "_fbp")[0]
  return first && INFINITE_FB_COOKIE.test(first) ? first : undefined
}

function infiniteNonEmptyString(value${t(": unknown")})${t(": string | null")} {
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** The device half of the match data: _fbc, _fbp, ip and user agent from the buyer's own request. */
function infiniteDeviceMatch(request${t(": InfiniteRequestLike | null | undefined")})${t(": InfiniteAdMatch")} {
  const headers = request ? request.headers : undefined
  const cookie = infiniteHeaderValue(headers, "cookie")
  const fbc = infiniteNewestFbc(cookie)
  const fbp = infiniteFbp(cookie)
  const clientIp = infiniteClientIpFrom(headers)
  const userAgent = infiniteHeaderValue(headers, "user-agent").trim()
  const output${t(": InfiniteAdMatch")} = {}
  if (fbc) output.fbc = fbc
  if (fbp) output.fbp = fbp
  if (clientIp && INFINITE_IP.test(clientIp)) output.client_ip_address = clientIp
  if (userAgent && INFINITE_USER_AGENT.test(userAgent)) output.client_user_agent = userAgent
  return output
}

async function infiniteAddDigest(
  output${t(": InfiniteAdMatch")},
  key${t(": keyof InfiniteAdMatch")},
  value${t(": string | null")},
  hasher${t(": typeof hashEmailForMeta")}
)${t(": Promise<void>")} {
  if (!value) return
  const digest = await hasher(value)
  if (digest) output[key] = digest
}

/**
 * Add the person's hashed details to match data the visitor allowed. undefined in, undefined out: no
 * match data means the page did not say the visitor allowed tracking, so nothing is added. A value that
 * does not normalize is left out. The name splits as Infinite's own sender does: the first word is fn,
 * EVERY later word is ln. Never a phone, whatever the caller passes.
 */
export async function personMatch(
  adMatch${t(": InfiniteAdMatch | undefined")},
  person${t(": InfinitePerson | null | undefined")}
)${t(": Promise<InfiniteAdMatch | undefined>")} {
  if (!adMatch) return undefined
  const output${t(": InfiniteAdMatch")} = { ...adMatch }
  if (!person) return output
  await infiniteAddDigest(output, "em", infiniteNonEmptyString(person.email), hashEmailForMeta)
  await infiniteAddDigest(output, "external_id", infiniteNonEmptyString(person.externalId), hashExternalId)
  const words = (infiniteNonEmptyString(person.name) ?? "").split(/\s+/).filter(Boolean)
  if (words.length > 0) await infiniteAddDigest(output, "fn", words[0] ?? null, hashNameForMeta)
  if (words.length > 1) await infiniteAddDigest(output, "ln", words.slice(1).join(" "), hashNameForMeta)
  const country = infiniteNonEmptyString(person.country)
  await infiniteAddDigest(output, "ct", infiniteNonEmptyString(person.city), hashCityForMeta)
  await infiniteAddDigest(output, "st", infiniteNonEmptyString(person.state), (state) => hashStateForMeta(state, country))
  await infiniteAddDigest(output, "zp", infiniteNonEmptyString(person.postcode), hashZipForMeta)
  await infiniteAddDigest(output, "country", country, hashCountryForMeta)
  return output
}

/**
 * Meta match data from the BUYER'S OWN request (the browser request this route is handling): their
 * _fbc/_fbp cookies, ip and user agent, plus the person's hashed details. undefined unless the page said
 * the visitor allowed tracking (trackingAllowed === true): this server cannot read that choice itself.
 * In a webhook the request is the provider's, not the buyer's: use contextFromMetadata + personMatch.
 */
export async function adMatchFromRequest(
  request${t(": InfiniteRequestLike")},
  options${t(": { trackingAllowed: boolean; person?: InfinitePerson | null }")}
)${t(": Promise<InfiniteAdMatch | undefined>")} {
  if (!options || options.trackingAllowed !== true) return undefined
  try {
    return await personMatch(infiniteDeviceMatch(request), options.person)
  } catch {
    return undefined
  }
}

/**
 * The 30-minute visit key, the same recipe as the page-view lane, so an outcome joins the visit that
 * led to it. The ip is hashed here and never leaves this process. "" only when no secret is set.
 */
export async function infiniteVisitKey(inputs${t(": { clientIp?: string; userAgent?: string; nowMs?: number; secret?: string }")})${t(": Promise<string>")} {
  const secret = inputs.secret || infiniteEnv(${JSON.stringify(SERVER_LANE_SECRET_ENV)})
  if (!secret) return ""
  const nowMs = inputs.nowMs ?? Date.now()
  const bucket = Math.floor(Math.floor(nowMs / 1000) / INFINITE_VISIT_BUCKET_SECONDS)
  return infiniteHmacHex(secret, ${JSON.stringify(VISIT_KEY_MESSAGE_PREFIX)} + (inputs.clientIp ?? "") + "|" + (inputs.userAgent ?? "") + "|" + bucket)
}

/**
 * At CHECKOUT, from the buyer's request: the visit key (Infinite's own first-party join, always) and the
 * device match data (only when the page said the visitor allowed tracking). Store it on the payment
 * session with contextMetadata; read it back in the webhook with contextFromMetadata.
 */
export async function buyerContext(
  request${t(": InfiniteRequestLike")},
  options${t(": { trackingAllowed: boolean }")}
)${t(": Promise<InfiniteBuyerContext>")} {
  const context${t(": InfiniteBuyerContext")} = {}
  try {
    const headers = request.headers
    const visitKey = await infiniteVisitKey({ clientIp: infiniteClientIpFrom(headers), userAgent: infiniteHeaderValue(headers, "user-agent") })
    if (visitKey) context.visitKey = visitKey
    if (options && options.trackingAllowed === true) {
      const adMatch = infiniteDeviceMatch(request)
      if (Object.keys(adMatch).length > 0) context.adMatch = adMatch
    }
  } catch {
    // The context is optional; the checkout never fails over it.
  }
  return context
}

/**
 * Product ids as ONE comma-joined token that fits Infinite's 120-character value limit: whole ids are
 * dropped, never cut, duplicates are dropped, and at most 20 are kept (Meta's own cap in the relay).
 * An id with a space or a comma in it cannot ride the token and is dropped too.
 */
export function infiniteContentIds(ids${t(": string | ReadonlyArray<string | null | undefined> | null | undefined")})${t(": string | undefined")} {
  const list = typeof ids === "string" ? ids.split(",") : Array.isArray(ids) ? ids : []
  const kept${t(": string[]")} = []
  let length = 0
  for (const raw of list) {
    const id = typeof raw === "string" ? raw.trim() : ""
    if (!id || id.includes(",") || !INFINITE_PROPERTY_VALUE.test(id) || kept.includes(id)) continue
    const next = length + (kept.length > 0 ? 1 : 0) + id.length
    if (next > 120) continue
    kept.push(id)
    length = next
    if (kept.length >= INFINITE_MAX_CONTENT_IDS) break
  }
  return kept.length > 0 ? kept.join(",") : undefined
}

function infiniteMetadataValue(value${t(": string | undefined")})${t(": string | undefined")} {
  return value && value.length <= INFINITE_STRIPE_METADATA_MAX ? value : undefined
}

/**
 * The buyer context and the cart as payment-session metadata (Stripe: checkout.sessions.create({ metadata })),
 * one field per value, for the webhook. A value Stripe would refuse (over 500 characters) is left out,
 * never cut. Empty until Infinite is configured, so nothing about the buyer is kept in Stripe before then.
 * Never put an email, a name or an address here: the webhook reads those from the paid session itself.
 */
export function contextMetadata(
  context${t(": InfiniteBuyerContext")},
  cart${t("?: { contentIds?: string | ReadonlyArray<string | null | undefined> | null; numItems?: number | null }")},
  credentials${t("?: InfiniteCredentials")}
)${t(": Record<string, string>")} {
  if (!infiniteConfigured(credentials)) return {}
  const numItems = cart && typeof cart.numItems === "number" && Number.isFinite(cart.numItems) && cart.numItems > 0 ? String(Math.round(cart.numItems)) : undefined
  const fields${t(": Record<string, string | undefined>")} = {
    infinite_checkout: "1",
    infinite_visit_key: context.visitKey,
    infinite_fbc: context.adMatch?.fbc,
    infinite_fbp: context.adMatch?.fbp,
    infinite_ip: context.adMatch?.client_ip_address,
    infinite_ua: context.adMatch?.client_user_agent,
    infinite_skus: infiniteContentIds(cart?.contentIds),
    infinite_num_items: numItems
  }
  const metadata${t(": Record<string, string>")} = {}
  for (const key of Object.keys(fields)) {
    const value = infiniteMetadataValue(fields[key])
    if (value) metadata[key] = value
  }
  return metadata
}

/**
 * In the WEBHOOK: the buyer context and the cart back from the session's metadata. siteCheckout is false
 * for a session this site's checkout did not create (a Payment Link, another integration on the same
 * account, or one created before Infinite was configured): skip those. Malformed values are dropped.
 */
export function contextFromMetadata(metadata${t(": Record<string, string> | null | undefined")})${t(": InfiniteCheckoutContext")} {
  const value = (key${t(": string")})${t(": string")} => {
    const raw = metadata ? metadata[key] : undefined
    return typeof raw === "string" ? raw.trim() : ""
  }
  const adMatch${t(": InfiniteAdMatch")} = {}
  if (INFINITE_FB_COOKIE.test(value("infinite_fbc"))) adMatch.fbc = value("infinite_fbc")
  if (INFINITE_FB_COOKIE.test(value("infinite_fbp"))) adMatch.fbp = value("infinite_fbp")
  if (INFINITE_IP.test(value("infinite_ip"))) adMatch.client_ip_address = value("infinite_ip")
  if (INFINITE_USER_AGENT.test(value("infinite_ua"))) adMatch.client_user_agent = value("infinite_ua")
  const numItems = Number(value("infinite_num_items"))
  const contentIds = infiniteContentIds(value("infinite_skus"))
  const context${t(": InfiniteCheckoutContext")} = { siteCheckout: value("infinite_checkout") === "1" }
  if (INFINITE_VISIT_KEY.test(value("infinite_visit_key"))) context.visitKey = value("infinite_visit_key")
  if (Object.keys(adMatch).length > 0) context.adMatch = adMatch
  if (contentIds) context.contentIds = contentIds
  if (Number.isInteger(numItems) && numItems > 0) context.numItems = numItems
  return context
}

/**
 * One stable id per person, shared by their lead and their purchase: HMAC-SHA256 of the normalized email
 * under ${LEAD_ID_SECRET_ENV}, a secret only this site holds (so nobody can test an email against it).
 * Use it RAW as the lead's event id (lead:<id>) and as InfinitePerson.externalId (personMatch hashes it
 * once for Meta). Null when ${LEAD_ID_SECRET_ENV} is not set or the email is not an email.
 */
export async function infiniteLeadId(email${t(": string | null | undefined")}, secret${t("?: string")})${t(": Promise<string | null>")} {
  const key = secret || infiniteEnv(${JSON.stringify(LEAD_ID_SECRET_ENV)})
  const normalized = typeof email === "string" ? normalizeEmailForMeta(email) : null
  if (!key || !normalized) return null
  return infiniteHmacHex(key, normalized)
}

function infiniteSameName(left${t(": string | null | undefined")}, right${t(": string | null | undefined")})${t(": boolean")} {
  return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase())
}

/**
 * The PAYER of a paid Stripe Checkout Session, never the recipient. Email and name come from
 * customer_details. The address comes WHOLE from one place: the billing address, or the shipping address
 * only when billing has no city AND the shipping name is the payer's own (trimmed, any case): a gift
 * shipped to someone else never lends the payer its address. The externalId is infiniteLeadId(email).
 * Read it in the webhook and pass it straight to personMatch: never store or log it.
 */
export async function stripeCheckoutPayer(session${t(": InfiniteStripeSessionLike")})${t(": Promise<InfinitePerson>")} {
  const details = session.customer_details ?? null
  const shipping = session.collected_information?.shipping_details ?? session.shipping_details ?? null
  const email = details?.email ?? null
  const name = details?.name ?? null
  const address = !details?.address?.city && infiniteSameName(shipping?.name, name) ? shipping?.address ?? null : details?.address ?? null
  return {
    email,
    externalId: await infiniteLeadId(email),
    name,
    city: address?.city || null,
    state: address?.state || null,
    postcode: address?.postal_code || null,
    country: address?.country || null
  }
}

/**
 * A Stripe amount (minor units) in major units for value. Zero-decimal currencies (JPY, KRW, ...) are not
 * divided; three-decimal ones (KWD, BHD, ...) are divided by 1000; everything else by 100.
 */
export function stripeAmountToMajor(amount${t(": number | null | undefined")}, currency${t(": string | null | undefined")})${t(": number | undefined")} {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined
  const code = typeof currency === "string" ? currency.trim().toLowerCase() : ""
  if (INFINITE_ZERO_DECIMAL.includes(code)) return amount
  if (INFINITE_THREE_DECIMAL.includes(code)) return Math.round(amount) / 1000
  return Math.round(amount) / 100
}

/** The path of the page that sent this request (same host only), or fallback. Never a query string. */
export function infinitePagePath(request${t(": InfiniteRequestLike")}, fallback${t(": string")})${t(": string")} {
  try {
    const url = new URL(infiniteHeaderValue(request.headers, "referer"))
    const host = infiniteHeaderValue(request.headers, "x-forwarded-host").split(",")[0]?.trim() || infiniteHeaderValue(request.headers, "host")
    if (host && url.host === host && INFINITE_PATH.test(url.pathname)) return url.pathname
  } catch {
    // No usable Referer.
  }
  return fallback
}

// ---- Sending ----

const INFINITE_NOT_SENT${t(": InfiniteOutcomeReport")} = { status: null, accepted: false, duplicate: false, metaEventId: null, metaEventName: null }
/** Refused here, before sending, for a reason a retry cannot fix: the same 400 Infinite would answer. */
const INFINITE_REFUSED${t(": InfiniteOutcomeReport")} = { ...INFINITE_NOT_SENT, status: 400 }

function infiniteOutcomePath(path${t(": unknown")})${t(": string | null")} {
  if (typeof path !== "string") return null
  const value = (path.trim().split(/[?#]/)[0] ?? "").trim()
  return INFINITE_PATH.test(value) ? value : null
}

/** "<type>:<eventId>" (unless already prefixed); over 160 characters, "<type>:" + sha256(eventId). */
async function infiniteWireId(type${t(": string")}, eventId${t(": string")})${t(": Promise<string>")} {
  const wire = eventId.startsWith(type + ":") ? eventId : type + ":" + eventId
  if (wire.length <= 160) return wire
  return type + ":" + (await sha256Hex(eventId))
}

/** Infinite's property rules, applied here so one bad value drops itself instead of the whole outcome. */
function infiniteCleanProperties(
  raw${t(": Record<string, InfinitePropertyValue> | undefined")},
  path${t(": string | null")}
)${t(": Record<string, string | number | boolean>")} {
  const out${t(": Record<string, string | number | boolean>")} = {}
  const dropped${t(": string[]")} = []
  let count = 0
  if (path) {
    out.path = path
    count = 1
  }
  for (const key of Object.keys(raw ?? {})) {
    if (key === "path") continue
    const value = raw ? raw[key] : undefined
    if (value === undefined || value === null || value === "") continue
    if (key === "visitKey") {
      if (typeof value === "string" && INFINITE_VISIT_KEY.test(value)) out.visitKey = value.toLowerCase()
      else dropped.push(key)
      continue
    }
    const candidate = key === "content_ids" && typeof value === "string" ? infiniteContentIds(value) : value
    // visitKey is not counted: Infinite lifts it out before its 16-property limit.
    if (!INFINITE_PROPERTY_KEY.test(key) || count >= INFINITE_MAX_PROPERTIES) {
      dropped.push(key)
      continue
    }
    if (
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate)) ||
      (typeof candidate === "string" && INFINITE_PROPERTY_VALUE.test(candidate))
    ) {
      out[key] = candidate
      count++
    } else {
      dropped.push(key)
    }
  }
  if (dropped.length > 0) infiniteWarn("dropped properties Infinite would refuse: " + dropped.join(", "))
  return out
}

function infiniteVisitInputs(input${t(": InfiniteOutcome[\"visitKeyInputs\"]")})${t(": { clientIp?: string; userAgent?: string } | null")} {
  if (!input) return null
  if ("headers" in input && input.headers) {
    return { clientIp: infiniteClientIpFrom(input.headers), userAgent: infiniteHeaderValue(input.headers, "user-agent") }
  }
  return input${t(" as { clientIp?: string; userAgent?: string }")}
}

function infiniteReadReport(body${t(": unknown")}, status${t(": number")})${t(": InfiniteOutcomeReport")} {
  if (!body || typeof body !== "object") return { ...INFINITE_NOT_SENT, status }
  const value = body${t(" as Record<string, unknown>")}
  const accepted = value.accepted === true
  const duplicate = value.duplicate === true
  // Only an accepted, first-time outcome can carry a mirror instruction; a duplicate never does.
  const mirror = accepted && !duplicate
  const metaEventName = mirror && typeof value.metaEventName === "string" && value.metaEventName ? value.metaEventName : null
  const metaEventId = metaEventName && typeof value.metaEventId === "string" && value.metaEventId ? value.metaEventId : null
  return { status, accepted, duplicate, metaEventId, metaEventName: metaEventId ? metaEventName : null }
}

/** Sign and POST one outcome; resolve Infinite's answer. Never throws and never rejects. */
async function infiniteSend(outcome${t(": InfiniteOutcome")})${t(": Promise<InfiniteOutcomeReport>")} {
  try {
    const type = outcome && typeof outcome.type === "string" ? outcome.type.trim() : ""
    const eventId = outcome ? infiniteNonEmptyString(outcome.eventId) : null
    if (!type || !eventId) {
      infiniteWarn("an outcome needs a type and a stable eventId; nothing was sent")
      return INFINITE_REFUSED
    }
    const secret = infiniteSecret(outcome.credentials)
    const sourceKey = infiniteSourceKey(outcome.credentials)
    if (!secret || !sourceKey) return INFINITE_NOT_SENT

    const rawPath = outcome.path ?? (outcome.properties ? outcome.properties.path : undefined)
    const path = infiniteOutcomePath(rawPath)
    if (rawPath !== undefined && rawPath !== null && rawPath !== "" && !path) infiniteWarn(type + ": path is not a plain page path; recorded without one, so Meta gets nothing")
    // One clock for the whole call: the event time and the visit-key bucket must agree.
    const nowMs = outcome.occurredAt instanceof Date && Number.isFinite(outcome.occurredAt.getTime()) ? outcome.occurredAt.getTime() : Date.now()
    const properties = infiniteCleanProperties(outcome.properties, path)
    const visitInputs = infiniteVisitInputs(outcome.visitKeyInputs)
    if (visitInputs && properties.visitKey === undefined) {
      const visitKey = await infiniteVisitKey({ clientIp: visitInputs.clientIp, userAgent: visitInputs.userAgent, nowMs, secret })
      if (visitKey) properties.visitKey = visitKey
    }
    const counted = () => Object.keys(properties).filter((key) => key !== "visitKey").length
    const campaign = outcome.campaign
    if (campaign && INFINITE_CAMPAIGN_PROVENANCE.includes(String(campaign.campaignProvenance)) && counted() < INFINITE_MAX_PROPERTIES) {
      properties.campaign_provenance = String(campaign.campaignProvenance)
    }
    if (campaign && INFINITE_BROWSER_CONTEXT.includes(String(campaign.browserContext)) && counted() < INFINITE_MAX_PROPERTIES) {
      properties.browser_context = String(campaign.browserContext)
    }

    const body = JSON.stringify({
      eventId: await infiniteWireId(type, eventId),
      eventName: type,
      occurredAt: new Date(nowMs).toISOString(),
      ...(outcome.accountKey ? { accountKey: outcome.accountKey } : {}),
      properties,
      // Inside the SIGNED body, so nobody without the secret can inject match data.
      ...(outcome.adMatch && Object.keys(outcome.adMatch).length > 0 ? { adMatch: outcome.adMatch } : {})
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), INFINITE_DELIVERY_TIMEOUT_MS)
    try {
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
      const status = response.status
      // 401: wrong secret or unknown site. Other 4xx: the name is not declared in Infinite, or a value was refused.
      if (!response.ok) {
        infiniteWarn(type + " report: Infinite answered " + status)
        return { ...INFINITE_NOT_SENT, status }
      }
      try {
        return infiniteReadReport(await response.json(), status)
      } catch {
        return { ...INFINITE_NOT_SENT, status }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    infiniteWarn("report not sent (network error or the 2 s timeout)")
    return INFINITE_NOT_SENT
  }
}

/**
 * Send one outcome and resolve Infinite's HTTP status (202 accepted), or null when nothing reached
 * Infinite: not configured yet, a network error, or the 2 s timeout. An outcome this helper refuses
 * before sending (no type or eventId) resolves 400, the answer Infinite would give. Never throws.
 *
 * In a payment WEBHOOK: answer 5xx (so the provider retries) only for null, 5xx, 401, 403 and 429, and
 * only after infiniteConfigured() was true; answer 200 for everything else.
 */
export async function ${OUTCOME_REPORT_EXPORT}(outcome${t(": InfiniteOutcome")})${t(": Promise<number | null>")} {
  return (await infiniteSend(outcome)).status
}

/**
 * The same send, resolving the whole answer, for a route whose response the PAGE waits on and that
 * returns { metaEventId, metaEventName } to it, for infiniteMetaMirror. metaEventId is null unless Infinite
 * is sending this conversion to Meta: then the page fires nothing.
 */
export async function ${OUTCOME_MIRROR_EXPORT}(outcome${t(": InfiniteOutcome")})${t(": Promise<InfiniteOutcomeReport>")} {
  return infiniteSend(outcome)
}

// ---- Stripe Checkout and leads, end to end (the recipes call these; nothing else to write) ----

/** Infinite answered something a retry can fix: not delivered, Infinite down, a secret fixed later, rate limited. */
function infiniteRetryable(status${t(": number | null")})${t(": boolean")} {
  return status === null || status >= 500 || status === 401 || status === 403 || status === 429
}

function infiniteStripeSession(value${t(": unknown")})${t(": InfiniteStripeCheckoutSession | null")} {
  if (!value || typeof value !== "object") return null
  const session = value${t(" as InfiniteStripeCheckoutSession")}
  return typeof session.id === "string" && session.id ? session : null
}

function infiniteCommerceProperties(
  session${t(": InfiniteStripeCheckoutSession")},
  context${t(": InfiniteCheckoutContext")}
)${t(": Record<string, InfinitePropertyValue>")} {
  const currency = typeof session.currency === "string" && /^[a-zA-Z]{3}$/.test(session.currency) ? session.currency.toUpperCase() : undefined
  return {
    value: stripeAmountToMajor(session.amount_total, session.currency),
    currency,
    content_ids: context.contentIds,
    num_items: context.numItems,
    visitKey: context.visitKey
  }
}

/**
 * CHECKOUT ROUTE, right after stripe.checkout.sessions.create({ ..., metadata: { ...contextMetadata(context, cart) } }):
 * reports begin_checkout (Meta InitiateCheckout through Infinite) from the session itself (its value,
 * currency, and the cart and buyer context the metadata now carries), in the background. Nothing is sent
 * for a session whose metadata this site did not fill (Infinite not configured yet).
 */
export async function reportStripeCheckoutStarted(
  session${t(": InfiniteStripeCheckoutSession")},
  options${t(": { path: string; type?: string }")}
)${t(": Promise<void>")} {
  const checkout = infiniteStripeSession(session)
  if (!checkout) return
  const context = contextFromMetadata(checkout.metadata)
  if (!context.siteCheckout) return
  await ${OUTCOME_BACKGROUND_EXPORT}({
    type: options.type || "begin_checkout",
    eventId: checkout.id,
    path: options.path,
    properties: infiniteCommerceProperties(checkout, context),
    adMatch: context.adMatch
  })
}

const INFINITE_PAID_CHECKOUT_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded"]

/**
 * PAYMENT WEBHOOK, after the Stripe signature check on the RAW body: reports the purchase (Meta Purchase
 * through Infinite) and resolves the HTTP status the webhook should answer.
 *
 * It reports only a paid, live (livemode) checkout.session.completed / async_payment_succeeded for a
 * session THIS site's checkout created, and only once Infinite is configured: everything else answers 200,
 * so Stripe never retries what can never be reported. Value is in major units (zero-decimal currencies
 * kept whole), the payer's email, name and address are read from the paid session and hashed here (never
 * stored, never logged, never a phone), and the event id is the session id, so both events for one
 * session and every Stripe retry count once. It answers 500 only when a retry can deliver the report:
 * not delivered, Infinite 5xx, 401, 403 or 429.
 */
export async function reportStripeCheckoutPurchase(
  event${t(": InfiniteStripeEventLike")},
  options${t(": { path: string; type?: string }")}
)${t(": Promise<200 | 500>")} {
  try {
    if (!infiniteConfigured() || !event || event.livemode !== true || !INFINITE_PAID_CHECKOUT_EVENTS.includes(event.type)) return 200
    const session = infiniteStripeSession(event.data ? event.data.object : null)
    if (!session || session.payment_status !== "paid") return 200
    const context = contextFromMetadata(session.metadata)
    if (!context.siteCheckout) return 200
    const status = await ${OUTCOME_REPORT_EXPORT}({
      type: options.type || "purchase",
      eventId: session.id,
      path: options.path,
      properties: infiniteCommerceProperties(session, context),
      adMatch: await personMatch(context.adMatch, await stripeCheckoutPayer(session))
    })
    return infiniteRetryable(status) ? 500 : 200
  } catch {
    return 500
  }
}

/**
 * LEAD / SIGN-UP ROUTE, once the sign-up is REAL (stored, subscribed): reports it in the background with
 * one stable id per person. The event id is "<type>:" + infiniteLeadId(email) (a re-submit counts once),
 * or fallbackId when ${LEAD_ID_SECRET_ENV} is not set. Match data (hashed em + the same external_id the
 * person's purchase carries, plus their cookies, ip and user agent) rides only when trackingAllowed.
 * The email is hashed here and never sent, stored or logged.
 */
export async function reportInfiniteLead(
  request${t(": InfiniteRequestLike")},
  options${t(`: {
    email: string
    trackingAllowed: boolean
    type?: string
    path?: string
    fallbackPath?: string
    fallbackId?: string | number | null
    properties?: Record<string, InfinitePropertyValue>
  }`)}
)${t(": Promise<void>")} {
  try {
    const type = options.type || "lead"
    const personId = await infiniteLeadId(options.email)
    const eventId = personId ?? infiniteNonEmptyString(options.fallbackId)
    if (!eventId) {
      infiniteWarn(type + ": no ${LEAD_ID_SECRET_ENV} and no fallbackId, so there is no stable id; nothing was sent")
      return
    }
    const context = await buyerContext(request, { trackingAllowed: options.trackingAllowed })
    await ${OUTCOME_BACKGROUND_EXPORT}({
      type,
      eventId,
      path: options.path || infinitePagePath(request, options.fallbackPath || "/"),
      properties: { ...(options.properties ?? {}), visitKey: context.visitKey },
      adMatch: await personMatch(context.adMatch, { email: options.email, externalId: personId })
    })
  } catch {
    // A report never fails the sign-up it describes.
  }
}

async function infiniteBoundedWait(task${t(": Promise<unknown>")})${t(": Promise<void>")} {
  let timer${t(": ReturnType<typeof setTimeout> | undefined")}
  await Promise.race([task, new Promise${t("<void>")}((resolve) => {
    timer = setTimeout(resolve, INFINITE_BACKGROUND_WAIT_MS)
  })])
  if (timer !== undefined) clearTimeout(timer)
}

${backgroundBlock(background, t)}`

  return managedGeneratedFile(
    [
      "// Infinite server lane: report a conversion the moment it becomes REAL (payment captured, row",
      "// committed), never on a click. Inert until the environment variables below are set.",
      "//",
      `//   import { ${OUTCOME_REPORT_EXPORT}, ${OUTCOME_BACKGROUND_EXPORT}, buyerContext, contextMetadata, contextFromMetadata, personMatch, stripeCheckoutPayer, stripeAmountToMajor } from "${importExample}"`,
      "//",
      "// Checkout route (the buyer's own request):",
      "//   const context = await buyerContext(req, { trackingAllowed: pageSaidTrackingAllowed })",
      "//   const session = await stripe.checkout.sessions.create({ ..., metadata: { ...contextMetadata(context, { contentIds, numItems }) } })",
      `//   await ${OUTCOME_BACKGROUND_EXPORT}({ type: "begin_checkout", eventId: session.id, path: "/cart", properties: { ... }, adMatch: context.adMatch })`,
      "//",
      "// Payment webhook (checkout.session.completed / async_payment_succeeded, paid, livemode only):",
      "//   const context = contextFromMetadata(session.metadata)   // skip unless context.siteCheckout",
      `//   const status = await ${OUTCOME_REPORT_EXPORT}({ type: "purchase", eventId: session.id, path: "/success",`,
      "//     properties: { value: stripeAmountToMajor(session.amount_total, session.currency), currency, content_ids: context.contentIds, num_items: context.numItems, visitKey: context.visitKey },",
      "//     adMatch: await personMatch(context.adMatch, await stripeCheckoutPayer(session)) })",
      "//",
      `// Environment: ${SERVER_LANE_SECRET_ENV} + ${SERVER_LANE_SOURCE_KEY_ENV} (from Infinite), ${LEAD_ID_SECRET_ENV} (your own random`,
      "// secret, for one stable id per person). Nothing is sent until they are set; secrets never go in a file."
    ],
    body
  )
}
