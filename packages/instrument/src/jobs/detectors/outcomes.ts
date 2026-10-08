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
import { codeMatches, codeView, isCodeFile, isHtmlFile, isNonProductPath, routePathOf, sortFindings, textMatches, type Finding } from "./shared.js"

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

/** API routes that take a lead (`/api/mailing-list`, `/api/subscribe`, `/api/contact`) or a signup (`/api/signup`). */
const LEAD_API_ROUTE = /^\/api\/(?:.*\/)?(?:mailing-?list|newsletter|subscribe|subscribers?|waitlist|wait-list|leads?|contact(?:-us)?|enquir(?:y|ies)|inquir(?:y|ies)|demo-?request)(?:\/|$)/i
const SIGNUP_API_ROUTE = /^\/api\/(?:.*\/)?(?:sign-?up|register|registration|create-account)(?:\/|$)/i

// ---------------------------------------------------------------------------------------------
// A sign-up route that saves nothing (live run 3): it validates and logs the email, and stores it nowhere
// ---------------------------------------------------------------------------------------------

/** Free calls that read or convert a value and reach nothing outside the request. */
const PURE_FREE_CALLS: ReadonlySet<string> = new Set(["String", "Number", "Boolean", "Array", "Date", "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI"])
/** `new X(…)` that builds a plain value or the response. */
const PURE_CONSTRUCTORS: ReadonlySet<string> = new Set(["Set", "Map", "WeakSet", "WeakMap", "URL", "URLSearchParams", "Date", "Error", "TypeError", "RangeError", "RegExp", "Response", "NextResponse", "Headers"])
/** Methods on a string, an array, a set or a pattern (and a schema's validation): they read, never send or store. */
const PURE_METHODS: ReadonlySet<string> = new Set([
  "trim", "trimStart", "trimEnd", "toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase", "normalize", "split", "slice", "substring",
  "substr", "replace", "replaceAll", "includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "join", "concat", "charAt", "charCodeAt", "at",
  "padStart", "padEnd", "repeat", "toString", "toFixed", "localeCompare", "filter", "map", "flatMap", "flat", "some", "every", "find", "findIndex",
  "reduce", "forEach", "keys", "values", "entries", "has", "get", "getAll", "test", "match", "matchAll", "exec", "parse", "safeParse"
])
/** Static helpers of the language's own objects. */
const PURE_STATIC_ROOTS: ReadonlySet<string> = new Set(["JSON", "Math", "Object", "Array", "Number", "String", "Date"])
const LOG_ROOTS: ReadonlySet<string> = new Set(["console", "logger", "log"])
const LOG_METHODS: ReadonlySet<string> = new Set(["log", "info", "warn", "error", "debug", "trace"])
/** The response the handler answers with (pages router `res`, Fastify `reply`, the Fetch / Next response). */
const RESPONSE_ROOTS: ReadonlySet<string> = new Set(["res", "response", "reply", "Response", "NextResponse"])
const RESPONSE_METHODS: ReadonlySet<string> = new Set(["status", "json", "send", "setHeader", "header", "end", "redirect", "type", "code", "writeHead", "sendStatus"])
/** Reading the request body: the one thing such a route may await. */
const REQUEST_ROOTS: ReadonlySet<string> = new Set(["req", "request"])
const BODY_READERS: ReadonlySet<string> = new Set(["json", "formData", "text"])
/** Words before `(` that are not calls. */
const NOT_A_CALL: ReadonlySet<string> = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "async", "do", "with", "in", "of", "else", "case", "void", "delete", "throw", "yield", "instanceof"])

/** The index of the bracket opening the one that closes at `close`, or -1. */
function openingBracket(code: string, close: number): number {
  let depth = 0
  for (let at = close; at >= 0; at -= 1) {
    const ch = code[at]
    if (ch === ")" || ch === "]" || ch === "}") depth += 1
    else if (ch === "(" || ch === "[" || ch === "{") {
      depth -= 1
      if (depth === 0) return at
    }
  }
  return -1
}

/**
 * The leftmost name of the member chain that ends with the `.` at `dot` (`res.status(400).json` → `res`), or null when the
 * chain starts with something else (a literal, a parenthesised expression).
 */
function chainRoot(code: string, dot: number): string | null {
  let at = dot - 1
  let root: string | null = null
  for (;;) {
    while (at >= 0 && /\s/.test(code[at]!)) at -= 1
    if (at < 0) return root
    const ch = code[at]!
    if (ch === ")" || ch === "]") {
      const open = openingBracket(code, at)
      if (open < 0) return null
      at = open - 1
      continue
    }
    if (!/[\w$]/.test(ch)) return root
    const end = at + 1
    while (at >= 0 && /[\w$]/.test(code[at]!)) at -= 1
    root = code.slice(at + 1, end)
    let before = at
    while (before >= 0 && /\s/.test(code[before]!)) before -= 1
    if (code[before] === "." && code[before - 1] !== ".") {
      at = before - (code[before - 1] === "?" ? 2 : 1)
      continue
    }
    return root
  }
}

/**
 * Live run 3: a sign-up or mailing-list API route whose handler does nothing but validate the request, log and answer:
 * no store, no provider, no mail, no awaited call beyond reading the request body. Reporting a lead there would count
 * sign-ups that were never created. CONSERVATIVE on purpose: any call the reading does not know (an imported helper, a
 * client, a fetch, a `.then`, an await of anything but the body) means the route may save, and it counts.
 */
export function routeSavesNothing(text: string): boolean {
  // Comments are blanked, string and template bodies KEPT: a call hidden in a `${…}` is still read (and a word with a
  // paren inside a plain string only ever makes the answer "it may save").
  const code = codeView(text, false)
  const local = new Set<string>()
  for (const match of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)|\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^()]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g)) {
    local.add((match[1] ?? match[2])!)
  }
  for (const match of code.matchAll(/(new\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g)) {
    const index = (match.index ?? 0) + (match[1]?.length ?? 0)
    const name = match[2]!
    if (NOT_A_CALL.has(name)) continue
    let before = index - 1
    while (before >= 0 && /\s/.test(code[before]!)) before -= 1
    // A declaration (`function redact(`), not a call.
    if (/\bfunction\s*\*?$/.test(code.slice(Math.max(0, before - 10), before + 1))) continue
    if (match[1]) {
      if (!PURE_CONSTRUCTORS.has(name)) return false
      continue
    }
    if (code[before] === ".") {
      const root = chainRoot(code, before)
      if (root !== null && LOG_ROOTS.has(root) && LOG_METHODS.has(name)) continue
      if (root !== null && RESPONSE_ROOTS.has(root) && RESPONSE_METHODS.has(name)) continue
      if (root !== null && REQUEST_ROOTS.has(root) && BODY_READERS.has(name)) continue
      const direct = /(?<![\w$.])(?<!\.\s+)([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(code.slice(Math.max(0, before - 60), before + 1))?.[1]
      if (direct !== undefined && direct === root && PURE_STATIC_ROOTS.has(direct)) continue
      if (PURE_METHODS.has(name)) continue
      return false
    }
    if (PURE_FREE_CALLS.has(name) || local.has(name)) continue
    return false
  }
  // The only awaits: the request body, or a function written in this same file (its body is read above).
  for (const match of code.matchAll(/\bawait\s+([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*)\s*)?\(/g)) {
    if (match[2] !== undefined ? REQUEST_ROOTS.has(match[1]!) && BODY_READERS.has(match[2]) : local.has(match[1]!)) continue
    return false
  }
  const awaits = [...code.matchAll(/\bawait\b/g)].length
  const knownAwaits = [...code.matchAll(/\bawait\s+[A-Za-z_$][\w$]*\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)?\(/g)].length
  return awaits === knownAwaits
}

/** One pass: the outcome handlers, and the sign-up / mailing-list routes that save nothing (never an outcome). */
function scanOutcomes(snapshot: RepoSnapshot): { outcomes: OutcomeFinding[]; unsaved: OutcomeFinding[] } {
  const findings: OutcomeFinding[] = []
  const unsaved: OutcomeFinding[] = []
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
    // A signup or mailing-list API route counts by its path even when the scan cannot name its store (an imported helper,
    // a provider client): `/api/mailing-list`, `/api/subscribe`, `/api/signup`. Live run 3: one that clearly only
    // validates and logs saves nothing, so there is no lead to report yet; it is kept apart, never an outcome.
    const formKind: OutcomeKind | null = route === null ? null : SIGNUP_API_ROUTE.test(route) ? "signup" : LEAD_API_ROUTE.test(route) ? "lead" : null
    if (formKind && !seenKinds.has(formKind)) {
      const handler = codeMatches(text, /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|handler)\b|export\s+default\b|export\s+const\s+(?:GET|POST)\b/g)[0]
      if (handler) (routeSavesNothing(text) ? unsaved : findings).push({ file: path, line: handler.line, detail: `${formKind} API route`, kind: formKind, conversionType: OUTCOME_TYPE[formKind], route })
    }
  }
  return { outcomes: sortFindings(findings), unsaved: sortFindings(unsaved) }
}

/** Pure: server-side outcome handlers, one finding per (file, kind) at the first matching line. */
export function detectOutcomes(snapshot: RepoSnapshot): OutcomeFinding[] {
  return scanOutcomes(snapshot).outcomes
}

/**
 * Pure: the sign-up and mailing-list API routes that save nothing yet (`routeSavesNothing`): no lead or sign-up is
 * reported from them, and the plan tells the owner why.
 */
export function detectUnsavedFormRoutes(snapshot: RepoSnapshot): OutcomeFinding[] {
  return scanOutcomes(snapshot).unsaved
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
  if (/contact|lead|waitlist|newsletter|mailing-?list/.test(lower)) return "lead"
  if (/book|demo|schedule/.test(lower)) return "booking"
  return null
}

/** A request the page sends to an outcome endpoint (`fetch("/api/signup"`, `axios.post("/api/leads"`). */
const OUTCOME_REQUEST = /\b(?:fetch|axios\s*\.\s*post|ky\s*\.\s*post)\s*\(\s*["'`]\/api\/([\w/-]+)["'`]/g

/** Existing success shapes: `.ok` (optionally AND a positive response `.success` flag),
 * `!error` / `!err`, or the first navigation after an await. No helper-call inference. */
const SUCCESS_OK = /\bif\s*\(\s*(?:await\s+)?[\w$.]+\.ok(?:\s*&&\s*[\w$]+(?:\?\.|\.)success(?:\s*===\s*true)?)?\s*\)/g
const SUCCESS_NO_ERROR = /\bif\s*\(\s*!\s*(?:error|err|result\.error|res\.error)\s*\)/g
/** A failure guard that leaves: `if (!res.ok) { …; return }` (or `throw`). The success is the code after it. */
const FAILURE_GUARD = /\bif\s*\(\s*!\s*(?:await\s+)?[\w$.]+\.ok\s*\)/g

/** The bracket closing the one at `open` in masked code (strings and comments blanked), or -1. */
function closingBracket(masked: string, open: number): number {
  let depth = 0
  for (let cursor = open; cursor < masked.length; cursor += 1) {
    const ch = masked[cursor]
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

/**
 * The success after a failure guard that leaves (`if (!res.ok) { setError(…); return }`, `if (!res.ok) throw …`): from
 * the end of the guard to the end of the block that holds it. `ifIndex` is the `if` in `masked` (strings and comments
 * blanked). Null when the `if` is not such a guard (another condition, or a branch that does not leave).
 */
export function failureGuardSuccess(masked: string, ifIndex: number): { start: number; end: number } | null {
  const open = masked.indexOf("(", ifIndex)
  const close = open < 0 ? -1 : closingBracket(masked, open)
  if (close < 0 || !/^\(\s*!\s*(?:await\s+)?[\w$.]+\.ok\s*\)$/.test(masked.slice(open, close + 1))) return null
  let cursor = close + 1
  while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor += 1
  let after: number
  if (masked[cursor] === "{") {
    const end = closingBracket(masked, cursor)
    if (end < 0 || !/\b(?:return|throw)\b/.test(masked.slice(cursor, end))) return null
    after = end + 1
  } else {
    const rest = masked.slice(cursor)
    if (!/^(?:return|throw)\b/.test(rest)) return null
    const stop = rest.search(/;|\n/)
    after = stop < 0 ? masked.length : cursor + stop + 1
  }
  // The block that holds the guard: the innermost `{` still open before it.
  let depth = 0
  let at = ifIndex - 1
  for (; at >= 0; at -= 1) {
    const ch = masked[at]
    if (ch === ")" || ch === "}" || ch === "]") depth += 1
    else if (ch === "(" || ch === "{" || ch === "[") {
      if (depth === 0) break
      depth -= 1
    }
  }
  if (at < 0 || masked[at] !== "{") return null
  const end = closingBracket(masked, at)
  return end < 0 ? null : { start: after, end }
}
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
    const masked = codeView(text, true)
    const ok =
      codeMatches(text, new RegExp(SUCCESS_OK.source, SUCCESS_OK.flags))[0] ??
      codeMatches(text, new RegExp(SUCCESS_NO_ERROR.source, SUCCESS_NO_ERROR.flags))[0] ??
      codeMatches(text, new RegExp(FAILURE_GUARD.source, FAILURE_GUARD.flags)).find((guard) => failureGuardSuccess(masked, guard.index) !== null)
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
