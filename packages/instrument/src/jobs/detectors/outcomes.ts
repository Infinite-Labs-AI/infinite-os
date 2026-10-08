// Jobs 8 (`server_conversions`) and 10 (`conversions_to_tools`) trigger detectors (lane O8).
//
// Server outcomes are where a conversion becomes REAL (a committed row, a captured payment, a served
// file), never a click: auth signup success, a lead insert, a download route, a payment webhook, a
// booking webhook. Beyond Stripe (the harness's `detectServerCheckout`, `ios:…/harness/marking.ts`),
// this covers Supabase / Firebase / Clerk / Better Auth / Lucia / Prisma / Drizzle signups, lead
// tables and email-list APIs, Lemon Squeezy / Paddle / Polar webhooks, and Cal.com / Calendly bookings.
// Only SERVER files count (route handlers, API routes, server actions, server modules): a browser-side
// `signUp()` has no server branch to report from.
//
// Conversion elements (job 10) are the links, buttons and forms where a visitor starts a conversion.
// They only tell the agent WHERE; the user names the conversions in the plan.
import type { ConversionType } from "../../wizard/contracts/bridge.js"
import type { RepoSnapshot } from "../repo-files.js"
import { codeMatches, isCodeFile, isHtmlFile, isNonProductPath, routePathOf, sortFindings, textMatches, type Finding } from "./shared.js"

export type OutcomeKind = "signup" | "lead" | "download" | "payment_webhook" | "trial" | "booking"

export interface OutcomeFinding extends Finding {
  kind: OutcomeKind
  conversionType: ConversionType
  /** The route the handler serves, when file-routed. */
  route: string | null
}

export interface ConversionElementFinding extends Finding {
  conversionType: ConversionType
}

const OUTCOME_TYPE: Record<OutcomeKind, ConversionType> = {
  signup: "signup",
  lead: "lead",
  download: "download",
  payment_webhook: "purchase",
  trial: "trial",
  booking: "booking"
}

const SERVER_PATH = /(?:^|\/)(?:app\/(?:.*\/)?route\.[cm]?[jt]s|pages\/api\/|api\/|server\/|functions\/|netlify\/functions\/|actions?\/|webhooks?\/)|\.server\.[cm]?[jt]sx?$/

/** Route handlers, API routes, server actions and server modules. */
export function isServerFile(path: string, text: string): boolean {
  return SERVER_PATH.test(path) || /^\s*["']use server["']/m.test(text)
}

const OUTCOME_PATTERNS: Array<{ kind: OutcomeKind; detail: string; pattern: RegExp; requires?: RegExp }> = [
  // Signup success.
  { kind: "signup", detail: "Supabase auth signUp", pattern: /\.auth\s*\.\s*signUp\s*\(/g },
  { kind: "signup", detail: "Supabase admin createUser", pattern: /\.auth\s*\.\s*admin\s*\.\s*createUser\s*\(/g },
  { kind: "signup", detail: "Firebase createUser", pattern: /\b(?:createUserWithEmailAndPassword|auth\(\)\s*\.\s*createUser)\s*\(/g },
  { kind: "signup", detail: "Clerk createUser", pattern: /\busers\s*\.\s*createUser\s*\(/g },
  { kind: "signup", detail: "Clerk user.created webhook", pattern: /["'`]user\.created["'`]/g, requires: /\b(?:svix|Webhook|verifyWebhook|evt\.type|event\.type)\b/ },
  { kind: "signup", detail: "Better Auth signUpEmail", pattern: /\.api\s*\.\s*signUpEmail\s*\(/g },
  { kind: "signup", detail: "Lucia createUser", pattern: /\b(?:lucia|auth)\s*\.\s*createUser\s*\(/g },
  { kind: "signup", detail: "user row insert", pattern: /\b(?:prisma|db|tx)\s*\.\s*(?:user|users|account|accounts)\s*\.\s*create\s*\(|\.insert\s*\(\s*(?:users|user|accounts)\s*\)|\.from\s*\(\s*["'`](?:users|profiles|accounts)["'`]\s*\)\s*\.\s*insert\s*\(/g },
  // Lead insert.
  { kind: "lead", detail: "lead row insert", pattern: /\.from\s*\(\s*["'`](?:leads?|contacts?|waitlist|wait_list|subscribers?|signups|newsletter|inquiries|enquiries|demo_requests)["'`]\s*\)\s*\.\s*(?:insert|upsert)\s*\(|\b(?:prisma|db|tx)\s*\.\s*(?:lead|leads|contact|contacts|waitlist|subscriber|subscribers|inquiry|demoRequest)\s*\.\s*(?:create|upsert)\s*\(|\.insert\s*\(\s*(?:leads?|contacts?|waitlist|subscribers?)\s*\)/g },
  { kind: "lead", detail: "email list subscribe", pattern: /\bcontacts\s*\.\s*create\s*\(|\blists\s*\.\s*(?:addListMember|setListMember)\s*\(|\bcreateContact\s*\(|\baddSubscriber\s*\(/g },
  // Download route.
  { kind: "download", detail: "attachment download", pattern: /Content-Disposition["'`]?\s*[:,]\s*[`"']attachment/gi },
  // Payment webhooks.
  { kind: "payment_webhook", detail: "Stripe webhook", pattern: /\bwebhooks\s*\.\s*constructEvent(?:Async)?\s*\(/g },
  { kind: "payment_webhook", detail: "Stripe checkout completed", pattern: /["'`](?:checkout\.session\.completed|checkout\.session\.async_payment_succeeded|invoice\.paid|invoice\.payment_succeeded|payment_intent\.succeeded)["'`]/g },
  { kind: "payment_webhook", detail: "Lemon Squeezy order", pattern: /["'`](?:order_created|subscription_payment_success)["'`]/g, requires: /lemon/i },
  { kind: "payment_webhook", detail: "Paddle transaction", pattern: /["'`](?:transaction\.completed|transaction\.paid)["'`]/g, requires: /paddle/i },
  { kind: "payment_webhook", detail: "Polar order", pattern: /["'`](?:order\.paid|order\.created)["'`]/g, requires: /polar/i },
  { kind: "trial", detail: "subscription trial", pattern: /["'`](?:customer\.subscription\.created|subscription_created)["'`]/g, requires: /trialing|trial_end|trial_ends_at|on_trial/ },
  // Bookings.
  { kind: "booking", detail: "Cal.com booking", pattern: /["'`]BOOKING_CREATED["'`]/g },
  { kind: "booking", detail: "Calendly invitee", pattern: /["'`]invitee\.created["'`]/g }
]

/** Pure: server-side outcome handlers, one finding per (file, kind) at the first matching line. */
export function detectOutcomes(snapshot: RepoSnapshot): OutcomeFinding[] {
  const findings: OutcomeFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !isCodeFile(path) || !isServerFile(path, text)) continue
    const route = routePathOf(path, snapshot.appRoot)
    const seenKinds = new Set<OutcomeKind>()
    for (const { kind, detail, pattern, requires } of OUTCOME_PATTERNS) {
      if (seenKinds.has(kind)) continue
      if (requires && !requires.test(text)) continue
      // Event-name strings are matched with strings kept; calls are matched as code.
      const isStringPattern = pattern.source.startsWith('["\'`]') || kind === "download"
      const match = (isStringPattern ? textMatches(text, new RegExp(pattern.source, pattern.flags)) : codeMatches(text, new RegExp(pattern.source, pattern.flags)))[0]
      if (!match) continue
      seenKinds.add(kind)
      findings.push({ file: path, line: match.line, detail, kind, conversionType: OUTCOME_TYPE[kind], route })
    }
    // A file-routed download handler counts even without an attachment header (it serves the file).
    if (!seenKinds.has("download") && route !== null && /(?:^|\/)(?:api\/)?downloads?(?:\/|$)/.test(route.slice(1))) {
      const handler = codeMatches(text, /export\s+(?:async\s+)?function\s+(?:GET|POST|handler)\b|export\s+default\b/g)[0]
      if (handler) findings.push({ file: path, line: handler.line, detail: "download route", kind: "download", conversionType: "download", route })
    }
  }
  return sortFindings(findings)
}

const ELEMENT_PATTERNS: Array<{ type: ConversionType; pattern: RegExp }> = [
  { type: "signup", pattern: /\bhref\s*=\s*\{?\s*["'`](?:\/(?:sign-?up|signup|register|join|get-started|create-account)\b)[^"'`]*["'`]/gi },
  { type: "trial", pattern: /\bhref\s*=\s*\{?\s*["'`](?:\/(?:start|trial|free-trial|start-trial)\b)[^"'`]*["'`]/gi },
  { type: "purchase", pattern: /\bhref\s*=\s*\{?\s*["'`](?:\/(?:checkout|buy|subscribe|purchase)\b|https:\/\/(?:buy|checkout)\.stripe\.com\/)[^"'`]*["'`]/gi },
  { type: "booking", pattern: /\bhref\s*=\s*\{?\s*["'`](?:\/(?:book|demo|book-a-demo|schedule)\b|https:\/\/(?:cal\.com|calendly\.com)\/)[^"'`]*["'`]/gi },
  { type: "lead", pattern: /\bhref\s*=\s*\{?\s*["'`](?:\/(?:contact|contact-us|waitlist|newsletter)\b)[^"'`]*["'`]/gi },
  { type: "download", pattern: /\bhref\s*=\s*\{?\s*["'`](?:\/(?:download|downloads)\b)[^"'`]*["'`]|\bdownload\s*=\s*["'{]/gi }
]

/** Pure: where visitors start a conversion (links, buttons, forms), by conversion type. */
export function detectConversionElements(snapshot: RepoSnapshot): ConversionElementFinding[] {
  const findings: ConversionElementFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !(isCodeFile(path) || isHtmlFile(path))) continue
    for (const { type, pattern } of ELEMENT_PATTERNS) {
      for (const match of textMatches(text, new RegExp(pattern.source, pattern.flags))) {
        findings.push({ file: path, line: match.line, detail: `${type} link`, conversionType: type })
      }
    }
    for (const match of textMatches(text, /<form\b[^>]*>/gi)) {
      const lower = path.toLowerCase()
      const type: ConversionType | null = /sign-?up|register/.test(lower)
        ? "signup"
        : /contact|lead|waitlist|newsletter|subscribe/.test(lower)
          ? "lead"
          : /book|demo/.test(lower)
            ? "booking"
            : null
      if (type) findings.push({ file: path, line: match.line, detail: `${type} form`, conversionType: type })
    }
  }
  return sortFindings(findings)
}

/** §3x.3 Conversion types whose conversion is an OUTCOME (a success), never the click that leads to the form. */
export const OUTCOME_CONVERSION_TYPES: ReadonlySet<ConversionType> = new Set<ConversionType>(["signup", "lead", "booking", "purchase", "trial"])

/** The conversion type a page's path names (the same reading as a form's type). */
function pathConversionType(path: string): ConversionType | null {
  const lower = path.toLowerCase()
  if (/sign-?up|register|create-account|join/.test(lower)) return "signup"
  if (/trial/.test(lower)) return "trial"
  if (/checkout|purchase|subscribe|buy/.test(lower)) return /subscribe/.test(lower) && /newsletter/.test(lower) ? "lead" : "purchase"
  if (/contact|lead|waitlist|newsletter/.test(lower)) return "lead"
  if (/book|demo|schedule/.test(lower)) return "booking"
  return null
}

/** A request the page sends to an outcome endpoint (`fetch("/api/signup"`, `axios.post("/api/leads"`). */
const OUTCOME_REQUEST = /\b(?:fetch|axios\s*\.\s*post|ky\s*\.\s*post)\s*\(\s*["'`]\/api\/([\w/-]+)["'`]/g

/** Existing success shapes: `.ok` (optionally AND a positive response `.success` flag),
 * `!error` / `!err`, or the first navigation after an await. No helper-call inference. */
const SUCCESS_OK = /\bif\s*\(\s*(?:await\s+)?[\w$.]+\.ok(?:\s*&&\s*[\w$]+(?:\?\.|\.)success(?:\s*===\s*true)?)?\s*\)/g
const SUCCESS_NO_ERROR = /\bif\s*\(\s*!\s*(?:error|err|result\.error|res\.error)\s*\)/g
const NAVIGATION = /\b(?:router\s*\.\s*(?:push|replace)|(?:window\s*\.\s*)?location\s*\.\s*(?:assign|replace)|redirect)\s*\(|\b(?:window\s*\.\s*)?location\s*\.\s*href\s*=/g
const PURCHASE_SUCCESS_PATH = /(?:^|\/)(?:success|thank-you|thanks|order-confirmation)(?:\/|$)/i
const PURCHASE_ANALYTICS = /\b(?:gtag\s*\(\s*["'`]event["'`]\s*,\s*["'`]purchase["'`]|posthog\s*\.\s*capture\s*\(\s*["'`]purchase["'`]|fbq\s*\(\s*["'`]track["'`]\s*,\s*["'`]Purchase["'`])/g
const CHECKOUT_SUCCESS_MARKER = /\b(?:session_id|checkout_session|checkout\.session|payment_intent|stripe)\b/gi

/**
 * §3x.3 (B3) Pure: where a conversion SUCCEEDS in the browser — the success branch of a form's submit handler (or of
 * a request to an outcome endpoint). Job 10 calls `infiniteTrack(<name>)` there for outcome conversions (signup,
 * lead, booking, purchase, trial); the links and buttons that lead to the form are intent, never the conversion.
 * One finding per (file, type), at the first success line.
 */
export function detectConversionSuccessPaths(snapshot: RepoSnapshot): ConversionElementFinding[] {
  const findings: ConversionElementFinding[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !isCodeFile(path) || isServerFile(path, text)) continue
    const types = new Set<ConversionType>()
    const evidenceLines = new Map<ConversionType, number>()
    if (textMatches(text, /<form\b[^>]*>/gi).length > 0) {
      const type = pathConversionType(path)
      if (type && OUTCOME_CONVERSION_TYPES.has(type)) types.add(type)
    }
    for (const request of textMatches(text, new RegExp(OUTCOME_REQUEST.source, OUTCOME_REQUEST.flags))) {
      const type = pathConversionType(`/api/${request.match[1] ?? ""}`)
      if (type && OUTCOME_CONVERSION_TYPES.has(type)) types.add(type)
    }
    const route = routePathOf(path, snapshot.appRoot) ?? path
    if (PURCHASE_SUCCESS_PATH.test(route)) {
      const purchase = codeMatches(text, new RegExp(PURCHASE_ANALYTICS.source, PURCHASE_ANALYTICS.flags))[0]
      const checkout = purchase ?? textMatches(text, new RegExp(CHECKOUT_SUCCESS_MARKER.source, CHECKOUT_SUCCESS_MARKER.flags))[0]
      if (checkout) {
        types.add("purchase")
        evidenceLines.set("purchase", checkout.line)
      }
    }
    if (types.size === 0) continue
    const ok = codeMatches(text, new RegExp(SUCCESS_OK.source, SUCCESS_OK.flags))[0] ?? codeMatches(text, new RegExp(SUCCESS_NO_ERROR.source, SUCCESS_NO_ERROR.flags))[0]
    let line: number | null = ok?.line ?? null
    if (line === null) {
      const awaited = codeMatches(text, /\bawait\b/g)[0]
      const navigation = codeMatches(text, new RegExp(NAVIGATION.source, NAVIGATION.flags)).find((entry) => awaited !== undefined && entry.index > awaited.index)
      line = navigation?.line ?? null
    }
    for (const type of types) {
      const foundLine = line ?? evidenceLines.get(type) ?? null
      if (foundLine === null) continue
      findings.push({ file: path, line: foundLine, detail: `${type} success`, conversionType: type })
    }
  }
  return sortFindings(findings)
}
