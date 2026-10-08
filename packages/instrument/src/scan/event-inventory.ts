// The event × tool inventory: where a site's funnel events already fire, and which tools get each one.
//
// The wizard fills GAPS only. Before it seeds a job that adds an event to a tool, it must know whether the site
// already sends that event there (a site that sends GA4 `purchase` must not get a second one). This reads the site's
// own code, never a live page:
//   • direct sends: `gtag('event', name)`, `posthog.capture(name)`, `fbq('track' | 'trackCustom', name)`,
//     `dataLayer.push({ event: name })`, Infinite's own `reportInfiniteOutcome({ type })`, `infiniteTrack(name)` and
//     `infiniteMetaMirror(name)`;
//   • the site's own SENDERS: a function that passes its own parameter as the event name to a send (or to another
//     sender), e.g. `sendGa(name, params)` → `gtag('event', name, params)`. Followed to a fixed point, so a chain
//     `track(name)` → `trackGoogleEvent(name)` → `gtag(...)` resolves;
//   • the site's own EVENT HELPERS: a function holding a literal send, e.g. `addToCart()` → `sendGa('add_to_cart')`.
//     One level: the places that call the helper are where the event fires (the trigger sites);
//   • server facts: Stripe Checkout session creation (begin_checkout on the server, and a purchase that needs a
//     payment webhook), an existing payment webhook, success / thank-you pages, signup and mailing-list API routes;
//   • the routes the site keeps its ad pixel off (`pixelRestrictedRoutes`, from a path list such as
//     `const META_RESTRICTED_ROUTES = ["/cart", "/success"]`);
//   • P1-A: for each browser trigger site, how the click LEAVES the page (`navigation`): a full page load
//     (`location.assign`, `location.href =`, a form post, a plain `<a href>`), client-side routing (`router.push`,
//     `<Link>`), or no navigation; and the site's own route-change hook that turns router navigations into full page
//     loads (`routeChangeFullLoad`, e.g. `router.events.on("routeChangeStart", …)` calling `location.assign`);
//   • P1-B: the signal a page sends its own API routes when the visitor allowed tracking (`trackingSignal`): the
//     site's own exported consent reader (`getConsent() === "granted"`, `trackingAllowed()`), read only, never edited;
//     `true` when the site has no consent gate at all; else the tag's `infiniteAdMatchAllowed()`.
//
// Pure: a function of a RepoSnapshot. Comments never count; tests, fixtures and mocks are never evidence; the
// wizard's own generated helpers (`infinite-*` files) are never read as the site's senders.
import { posix } from "node:path"

import { codeView, isCodeFile, isHtmlFile, isNonProductPath, routePathOf } from "../jobs/detectors/shared.js"
import { detectOutcomes, isServerFile, type OutcomeFinding } from "../jobs/detectors/outcomes.js"
import type { RepoSnapshot } from "../jobs/repo-files.js"
import { outcomesIn } from "../checks/commerce-static.js"
import { isConsentFile, isConsentText } from "../jobs/consent-units.js"
import { escapeRegExp } from "../text-escape.js"

export type InventoryTool = "ga4" | "posthog" | "meta_browser" | "meta_server" | "infinite"
export type FunnelEvent = "view_item" | "add_to_cart" | "begin_checkout" | "purchase" | "lead" | "sign_up" | "start_trial"
/** How a browser trigger site's click leaves the page (P1-A). Absent = the scan could not tell (it saw no navigation). */
export type SiteNavigation = "full_load" | "client" | "none"
export interface EventSite {
  file: string
  line: number
  via: string // "gtag", "posthog.capture", "fbq", "dataLayer", "helper:<fn>", "stripe.checkout.sessions.create", "success-page", "form-api", …
  /** A browser trigger site: what its handler does after the event (P1-A). */
  navigation?: SiteNavigation
  /** The navigation as written, in plain words (`router.push("/cart")`, `window.location.assign`, `a form post`). */
  navigationVia?: string
  /**
   * A full page load the handler's own code does not write: the element's default action (`link`: a plain `<a href>`,
   * or a button inside one; `form`: a form that submits), or the site's route-change hook turning router navigation into
   * a full load (`route_hook`). Absent: the handler's own code navigates.
   */
  leavesBy?: "link" | "form" | "route_hook"
  /** A `helper:<fn>` trigger site: where the site's own helper is defined. */
  helperAt?: { file: string; line: number }
}

/**
 * P1-B: what a page sends its own API route as "the visitor allowed tracking" (`ad_match=1` / `adMatch: true`).
 *   site_getter — the site's own exported consent reader, read only (`expression` is the call, `name` its export);
 *   always      — the site has no consent gate at all: the signal is `true`;
 *   tag_helper  — a gate exists but no reader the page can import: the tag's `infiniteAdMatchAllowed()`.
 */
export type TrackingSignal =
  | { kind: "site_getter"; expression: string; name: string; file: string; line: number }
  | { kind: "always" }
  | { kind: "tag_helper" }
export interface EventInventoryEntry { event: FunnelEvent; sites: EventSite[]; tools: Partial<Record<InventoryTool, EventSite[]>>; missing: InventoryTool[] }

/**
 * How a page sends its request to one of the site's own server routes, which decides where the route reads the page's
 * tracking signal:
 *   form    — a form that posts: a hidden field, read from the parsed request body (`req.body.ad_match`);
 *   json    — a fetch with a JSON body: `adMatch` in that body (`req.body.adMatch`);
 *   query   — a link, a GET form or a fetch with no body: `ad_match=1` in the URL (`req.query.ad_match`);
 *   unknown — the scan saw the route's path but not how the request goes.
 */
export type PageRequestHow = "form" | "json" | "query" | "unknown"
export interface PageRequest {
  /** The server route file the request reaches. */
  route: string
  /** The page that sends it, and where. */
  file: string
  line: number
  how: PageRequestHow
  /** In plain words: "a form that posts", "a JSON fetch", "a link", … */
  via: string
}

export interface EventInventory {
  events: EventInventoryEntry[]
  checkoutCreates: EventSite[]
  paymentWebhook: EventSite | null
  pixelRestrictedRoutes: string[]
  /** The pages that send a request to the checkout and sign-up routes, and how (where the route reads the signal). */
  pageRequests?: PageRequest[]
  /** P1-A: the site's own route-change hook that turns a router navigation into a full page load, or null. */
  routeChangeFullLoad?: EventSite | null
  /** P1-B: the signal the page sends its own API routes when the visitor allowed tracking. */
  trackingSignal?: TrackingSignal
  /**
   * The currency the site prices in (ISO 4217, upper case), from its own code: the currency its Stripe Checkout
   * sessions charge in, else the one currency its code names (`currency: "USD"`, `Intl.NumberFormat(…, { currency })`).
   * Null when the code names none, or more than one with no checkout to settle it.
   */
  siteCurrency: string | null
}

export const FUNNEL_EVENTS: readonly FunnelEvent[] = ["view_item", "add_to_cart", "begin_checkout", "purchase", "lead", "sign_up", "start_trial"]
export const INVENTORY_TOOLS: readonly InventoryTool[] = ["ga4", "posthog", "meta_browser", "meta_server", "infinite"]

/** The item target the browser commerce-event jobs (3, 4 and 5) are seeded under: `meta_improve:commerce_events`, … */
export const COMMERCE_EVENTS_TARGET = "commerce_events"

/** The `via` of a trigger site in server code: the server lane reports from there, never a browser call. */
export const SERVER_SITE_VIAS: ReadonlySet<string> = new Set(["stripe.checkout.sessions.create", "form-api", "payment-webhook", "reportInfiniteOutcome"])

/** The browser-only commerce steps (Meta gets them from the pixel). */
export const BROWSER_COMMERCE_EVENTS: readonly FunnelEvent[] = ["view_item", "add_to_cart"]
/** The events Meta gets from the server (through Infinite's relay) and Infinite records as conversions. */
export const SERVER_FUNNEL_EVENTS: readonly FunnelEvent[] = ["begin_checkout", "purchase", "lead", "sign_up", "start_trial"]

/**
 * Which tools should get each event. GA4 and PostHog get every step. Meta gets the browser steps from the pixel and
 * the conversions from the server. Infinite records the conversions (from the server).
 */
export const EXPECTED_TOOLS: Readonly<Record<FunnelEvent, readonly InventoryTool[]>> = {
  view_item: ["ga4", "posthog", "meta_browser"],
  add_to_cart: ["ga4", "posthog", "meta_browser"],
  begin_checkout: ["ga4", "posthog", "meta_server", "infinite"],
  purchase: ["ga4", "posthog", "meta_server", "infinite"],
  lead: ["ga4", "posthog", "meta_server", "infinite"],
  sign_up: ["ga4", "posthog", "meta_server", "infinite"],
  start_trial: ["ga4", "posthog", "meta_server", "infinite"]
}

/** Meta's standard event for each funnel event (the names the relay maps the outcome names onto). */
export const META_EVENT_NAME: Readonly<Record<FunnelEvent, string>> = {
  view_item: "ViewContent",
  add_to_cart: "AddToCart",
  begin_checkout: "InitiateCheckout",
  purchase: "Purchase",
  lead: "Lead",
  sign_up: "CompleteRegistration",
  start_trial: "StartTrial"
}

// The GA4, PostHog, Segment-style and Meta names a site uses for each step, normalised (snake case, lower case).
const EVENT_NAME_VARIANTS: Readonly<Record<FunnelEvent, readonly string[]>> = {
  view_item: ["view_item", "view_content", "viewcontent", "product_viewed", "product_view", "viewed_product", "view_product", "item_viewed", "product_detail_viewed", "view_item_details"],
  add_to_cart: ["add_to_cart", "addtocart", "added_to_cart", "product_added", "product_added_to_cart", "add_item_to_cart", "cart_add", "item_added_to_cart", "cart_item_added", "add_to_bag"],
  begin_checkout: ["begin_checkout", "checkout_started", "initiate_checkout", "initiatecheckout", "start_checkout", "checkout_begin", "checkout_initiated", "began_checkout", "started_checkout"],
  purchase: ["purchase", "purchase_completed", "order_completed", "order_placed", "checkout_completed", "checkout_complete", "completed_purchase", "payment_completed", "purchased", "order_complete", "transaction_completed"],
  lead: ["lead", "generate_lead", "lead_captured", "lead_submitted", "mailing_list_joined", "mailing_list_signup", "newsletter_signup", "newsletter_subscribed", "newsletter_joined", "waitlist_joined", "joined_waitlist", "waitlist_signup", "contact_form_submitted", "contact_submitted", "email_subscribed", "subscribe_newsletter"],
  sign_up: ["sign_up", "signup", "signed_up", "user_signed_up", "account_created", "registration", "complete_registration", "completeregistration", "registered", "user_registered", "create_account"],
  start_trial: ["start_trial", "starttrial", "trial_started", "trial_start", "started_trial", "free_trial_started"]
}

const NAME_TO_EVENT: ReadonlyMap<string, FunnelEvent> = new Map(
  (Object.entries(EVENT_NAME_VARIANTS) as Array<[FunnelEvent, readonly string[]]>).flatMap(([event, names]) => names.map((name) => [name, event] as const))
)

/** Snake case, lower case: `AddToCart` → `add_to_cart`, `Order Completed` → `order_completed`. */
export function normalizeEventName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase()
}

/** The funnel event a site's event name means, or null (`product_added` → add_to_cart). */
export function funnelEventOf(name: string): FunnelEvent | null {
  return NAME_TO_EVENT.get(normalizeEventName(name)) ?? NAME_TO_EVENT.get(name.trim().toLowerCase()) ?? null
}

// ---------------------------------------------------------------------------------------------
// One file's code views
// ---------------------------------------------------------------------------------------------

interface FunctionDef {
  name: string | null
  params: string[]
  /** Offsets of the body (inside the braces, or the arrow's expression). */
  start: number
  end: number
}

interface FileView {
  path: string
  text: string
  /** Comments blanked (strings kept), offsets kept. */
  comments: string
  /** Comments and string contents blanked, offsets kept. */
  code: string
  lineStarts: number[]
  functions: FunctionDef[]
  server: boolean
  generated: boolean
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1)
  return starts
}

function lineAt(view: FileView, offset: number): number {
  let low = 0
  let high = view.lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (view.lineStarts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return low + 1
}

const OPEN: Record<string, string> = { "(": ")", "{": "}", "[": "]" }

/** The offset of the bracket closing the one at `open` (in the string-blanked code), or -1. */
function matchingClose(code: string, open: number): number {
  const stack: string[] = []
  for (let index = open; index < code.length; index += 1) {
    const ch = code[index]!
    if (ch in OPEN) stack.push(OPEN[ch]!)
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1
      if (stack.length === 0) return index
    }
  }
  return -1
}

/** The top-level comma-separated pieces of `code.slice(start, end)`, as offsets. */
function splitTopLevel(code: string, start: number, end: number): Array<[number, number]> {
  const pieces: Array<[number, number]> = []
  let depth = 0
  let from = start
  for (let index = start; index < end; index += 1) {
    const ch = code[index]!
    if (ch in OPEN) depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1
    else if (ch === "," && depth === 0) {
      pieces.push([from, index])
      from = index + 1
    }
  }
  if (code.slice(from, end).trim() !== "") pieces.push([from, end])
  return pieces
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*/

function paramNames(code: string, open: number, close: number): string[] {
  return splitTopLevel(code, open + 1, close).map(([from, to]) => {
    const piece = code.slice(from, to).trim().replace(/^\.\.\./, "")
    return IDENTIFIER.exec(piece)?.[0] ?? ""
  })
}

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await", "new", "else", "do", "try", "with"])

/** Named function declarations, function expressions and arrow functions bound to a name, plus anonymous arrows. */
function functionsOf(code: string): FunctionDef[] {
  const out: FunctionDef[] = []
  const bodyAfter = (closeParen: number): { start: number; end: number } | null => {
    // Skip a return type annotation (`): Promise<void> {`, `): boolean =>`), then take a braced body or an arrow's expression.
    let index = closeParen + 1
    const rest = code.slice(index, index + 200)
    const arrow = /^\s*(?::\s*[^={;]*?)?\s*=>\s*/.exec(rest)
    const block = /^\s*(?::\s*[^{;]*?)?\s*\{/.exec(rest)
    if (arrow) {
      index += arrow[0].length
      if (code[index] === "{") {
        const end = matchingClose(code, index)
        return end < 0 ? null : { start: index + 1, end }
      }
      // An expression body: to the end of the statement (a `;`, or a newline at depth 0).
      let depth = 0
      let at = index
      for (; at < code.length; at += 1) {
        const ch = code[at]!
        if (ch in OPEN) depth += 1
        else if (ch === ")" || ch === "}" || ch === "]") {
          if (depth === 0) break
          depth -= 1
        } else if ((ch === ";" || ch === "," || ch === "\n") && depth === 0) break
      }
      return { start: index, end: at }
    }
    if (block) {
      const open = index + block[0].length - 1
      const end = matchingClose(code, open)
      return end < 0 ? null : { start: open + 1, end }
    }
    return null
  }
  const taken = new Set<number>()
  const push = (name: string | null, openParen: number) => {
    if (taken.has(openParen)) return
    const close = matchingClose(code, openParen)
    if (close < 0) return
    const body = bodyAfter(close)
    if (!body) return
    taken.add(openParen)
    out.push({ name, params: paramNames(code, openParen, close), start: body.start, end: body.end })
  }
  // `function name(` (and `const name = function (`).
  for (const match of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>()]*>)?\s*\(/g)) {
    const index = match.index ?? 0
    const bound = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?$/.exec(code.slice(Math.max(0, index - 120), index))?.[1]
    push(match[1] ?? bound ?? null, index + match[0].length - 1)
  }
  // `const name = (params) => …` / `const name = async (params) => …`.
  for (const match of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?(?:<[^>()]*>\s*)?\(/g)) {
    push(match[1]!, (match.index ?? 0) + match[0].length - 1)
  }
  // Methods (`track(name, params) {` inside an object or a class).
  for (const match of code.matchAll(/(?:^|[\n;{},])\s*(?:async\s+|static\s+|public\s+|private\s+)*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!
    if (KEYWORDS.has(name)) continue
    const openParen = (match.index ?? 0) + match[0].length - 1
    const close = matchingClose(code, openParen)
    if (close < 0 || !/^\s*(?::\s*[^{;=]*?)?\s*\{/.test(code.slice(close + 1, close + 200))) continue
    push(name, openParen)
  }
  // Anonymous arrows (`useEffect(() => …)`, `onClick={() => …}`): no name, but their params bind identifiers.
  for (const match of code.matchAll(/\(([^()]*)\)\s*(?::\s*[\w<>[\]|\s.]+)?\s*=>/g)) push(null, match.index ?? 0)
  return out
}

function viewOf(path: string, text: string): FileView {
  const comments = codeView(text, false)
  const code = codeView(text, true)
  const view: FileView = {
    path,
    text,
    comments,
    code,
    lineStarts: lineStartsOf(text),
    functions: functionsOf(code),
    server: isServerFile(path, text),
    generated: /(?:^|\/)infinite-[^/]*$/.test(path)
  }
  return view
}

/** The line a named function is declared on (its name, else its body). */
function helperLine(view: FileView, fn: FunctionDef): number {
  const head = view.code.slice(Math.max(0, fn.start - 300), fn.start)
  const at = fn.name ? head.lastIndexOf(fn.name) : -1
  return lineAt(view, at < 0 ? fn.start : Math.max(0, fn.start - 300) + at)
}

/** The functions enclosing `offset`, innermost first. */
function enclosing(view: FileView, offset: number): FunctionDef[] {
  return view.functions.filter((fn) => fn.start <= offset && offset < fn.end).sort((a, b) => b.start - a.start || a.end - b.end)
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

type Arg = { kind: "literal"; value: string } | { kind: "ident"; value: string } | { kind: "other" }

/** The argument starting at `offset` (comments blanked, strings kept). */
function argAt(view: FileView, offset: number): Arg {
  let index = offset
  while (index < view.comments.length && /\s/.test(view.comments[index]!)) index += 1
  const ch = view.comments[index]
  if (ch === "'" || ch === '"' || ch === "`") {
    const close = view.code.indexOf(ch, index + 1)
    if (close < 0) return { kind: "other" }
    const value = view.comments.slice(index + 1, close)
    if (ch === "`" && value.includes("${")) return { kind: "other" }
    return { kind: "literal", value }
  }
  const ident = /^[A-Za-z_$][\w$]*/.exec(view.comments.slice(index, index + 100))
  if (ident) {
    const after = view.comments.slice(index + ident[0].length, index + ident[0].length + 2).trimStart()
    if (after.startsWith("(") || after.startsWith(".")) return { kind: "other" }
    return { kind: "ident", value: ident[0] }
  }
  return { kind: "other" }
}

/** The offsets of each top-level argument of the call whose `(` is at `openParen`. */
function callArgs(view: FileView, openParen: number): Array<[number, number]> {
  const close = matchingClose(view.code, openParen)
  if (close < 0) return []
  return splitTopLevel(view.code, openParen + 1, close)
}

/** A call prefix that is code (not inside a string or a comment). */
function isCode(view: FileView, index: number, length: number): boolean {
  return view.code.slice(index, index + length) === view.comments.slice(index, index + length) && view.comments.slice(index, index + length).trim() !== ""
}

// ---------------------------------------------------------------------------------------------
// Sends
// ---------------------------------------------------------------------------------------------

interface Send {
  tool: InventoryTool
  view: FileView
  offset: number
  via: string
  arg: Arg
}

interface RawCall {
  tools: InventoryTool[]
  via: string
  /** The offset of the call's `(`. */
  openParen: number
  /** Which argument holds the event name. */
  argIndex: number
  /** For an object argument: the key holding the name (`event` in dataLayer.push({event})). */
  objectKey?: string
}

const DIRECT_CALLS: ReadonlyArray<{ pattern: RegExp; tools: InventoryTool[]; via: string; argIndex: (match: RegExpMatchArray) => number; objectKey?: string; serverOnly?: boolean }> = [
  { pattern: /\bgtag\s*(?:\?\.\s*)?\(\s*(['"`])event\1\s*,/g, tools: ["ga4"], via: "gtag", argIndex: () => 1 },
  // A gtag reached through a getter: `ensureGtag()("event", name)`, `getGtag()?.("event", name)`.
  { pattern: /\b[\w$]*[gG]tag[\w$]*\s*\(\s*\)\s*(?:\?\.\s*)?\(\s*(['"`])event\1\s*,/g, tools: ["ga4"], via: "gtag", argIndex: () => 1 },
  { pattern: /\bposthog\s*(?:\?\.|\.)\s*capture\s*\(/g, tools: ["posthog"], via: "posthog.capture", argIndex: () => 0 },
  { pattern: /\bfbq\s*(?:\?\.\s*)?\(\s*(['"`])(track|trackCustom|trackSingle|trackSingleCustom)\1\s*,/g, tools: ["meta_browser"], via: "fbq", argIndex: (match) => (match[2]!.startsWith("trackSingle") ? 2 : 1) },
  { pattern: /\bdataLayer\s*(?:\?\.|\.)\s*push\s*\(/g, tools: ["ga4"], via: "dataLayer", argIndex: () => 0, objectKey: "event" },
  { pattern: /\b(?:reportInfiniteOutcome(?:InBackground|ForMirror)?|postInfiniteOutcome)\s*\(/g, tools: ["infinite", "meta_server"], via: "reportInfiniteOutcome", argIndex: () => 0, objectKey: "type" },
  { pattern: /\binfiniteMetaMirror\s*\(/g, tools: ["meta_browser"], via: "infiniteMetaMirror", argIndex: () => 0 }
]

function rawCallsOf(view: FileView): RawCall[] {
  const calls: RawCall[] = []
  for (const spec of DIRECT_CALLS) {
    for (const match of view.comments.matchAll(new RegExp(spec.pattern.source, spec.pattern.flags))) {
      const index = match.index ?? 0
      const paren = index + match[0].lastIndexOf("(")
      if (paren <= index || !isCode(view, index, paren - index)) continue
      calls.push({ tools: spec.tools, via: spec.via, openParen: paren, argIndex: spec.argIndex(match), ...(spec.objectKey ? { objectKey: spec.objectKey } : {}) })
    }
  }
  // The wizard's own browser helpers: `infiniteTrack(name, props, { destinations })`, `infiniteTrackThenNavigate(e, target, name)`.
  for (const match of view.comments.matchAll(/\binfiniteTrack(ThenNavigate|BeforeLeaving)?\s*\(/g)) {
    const index = match.index ?? 0
    const paren = index + match[0].length - 1
    if (!isCode(view, index, paren - index)) continue
    const close = matchingClose(view.code, paren)
    const callText = close < 0 ? "" : view.comments.slice(paren, close)
    // `destinations: ["meta"]` (a list) sends to exactly those tools; `destinations: { ga4: false }` turns one off
    // (absent = on) and `{ meta: true }` turns Meta on (`conversions/track.ts`).
    const list = /\b(?:destinations|tools)\s*:\s*\[([^\]]*)\]/.exec(callText)?.[1]
    const object = /\b(?:destinations|tools)\s*:\s*\{([^}]*)\}/.exec(callText)?.[1]
    const named = list === undefined ? null : new Set([...list.matchAll(/(['"`])([a-z0-9_]+)\1/g)].map((match) => match[2]!))
    const set = (key: string): boolean | null => (named ? named.has(key) : object === undefined ? null : new RegExp(`\\b${key}\\s*:\\s*true\\b`).test(object) ? true : new RegExp(`\\b${key}\\s*:\\s*false\\b`).test(object) ? false : null)
    const tools: InventoryTool[] = []
    for (const [key, tool] of [["ga4", "ga4"], ["posthog", "posthog"]] as const) if (set(key) ?? true) tools.push(tool)
    // The helper sends Meta's ViewContent / AddToCart for those two events unless Meta is turned off.
    const argIndex = match[1] === "ThenNavigate" ? 2 : 0
    const name = nameArg(view, { openParen: paren, argIndex })
    const metaByName = name?.arg.kind === "literal" && BROWSER_COMMERCE_EVENTS.includes(funnelEventOf(name.arg.value) as FunnelEvent)
    if (set("meta") === true || ((metaByName || /\bmetaEventName\s*:/.test(callText)) && set("meta") !== false)) tools.push("meta_browser")
    calls.push({ tools, via: `infiniteTrack${match[1] ?? ""}`, openParen: paren, argIndex })
  }
  return calls
}

/** The name argument of a call: the positional argument, or the `key:` inside an object argument. */
function nameArg(view: FileView, call: { openParen: number; argIndex: number; objectKey?: string }): { arg: Arg; offset: number } | null {
  const args = callArgs(view, call.openParen)
  const piece = args[call.argIndex]
  if (!piece) return null
  if (!call.objectKey) return { arg: argAt(view, piece[0]), offset: piece[0] }
  const objectOpen = view.code.indexOf("{", piece[0])
  if (objectOpen < 0 || objectOpen >= piece[1]) return null
  const objectClose = matchingClose(view.code, objectOpen)
  if (objectClose < 0) return null
  for (const [from, to] of splitTopLevel(view.code, objectOpen + 1, objectClose)) {
    const key = new RegExp(`^\\s*['"]?${call.objectKey}['"]?\\s*:`).exec(view.comments.slice(from, to))
    if (key) return { arg: argAt(view, from + key[0].length), offset: from + key[0].length }
  }
  return null
}

// ---------------------------------------------------------------------------------------------
// Imports (so a sender named `track` in one file is not another file's `track`)
// ---------------------------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"]

function resolveImport(files: ReadonlyMap<string, unknown>, from: string, specifier: string): string | null {
  const candidates: string[] = []
  if (specifier.startsWith(".")) candidates.push(posix.normalize(posix.join(posix.dirname(from), specifier)))
  else if (/^[@~#]\//.test(specifier)) candidates.push(specifier.slice(2), `src/${specifier.slice(2)}`)
  else return null
  for (const base of candidates) {
    for (const extension of RESOLVE_EXTENSIONS) {
      const path = `${base}${extension}`
      if (files.has(path)) return path
      // A monorepo app root: match by suffix.
      for (const file of files.keys()) if (file.endsWith(`/${path}`)) return file
    }
  }
  return null
}

/** name → the file it is imported from (named imports only), for one file. */
function importsOf(view: FileView, files: ReadonlyMap<string, unknown>): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of view.comments.matchAll(/\bimport\s+(?:type\s+)?([^;]*?)\s+from\s+(['"])([^'"]+)\2/g)) {
    const resolved = resolveImport(files, view.path, match[3]!)
    if (!resolved) continue
    const clause = match[1]!
    const named = /\{([^}]*)\}/.exec(clause)?.[1] ?? ""
    for (const part of named.split(",")) {
      const [imported, local] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)
      if (imported) out.set((local ?? imported).trim(), resolved)
    }
    const defaultName = /^\s*([A-Za-z_$][\w$]*)/.exec(clause.replace(/\{[^}]*\}/, ""))?.[1]
    if (defaultName) out.set(defaultName, resolved)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------------------------

interface Sender {
  file: string
  name: string
  argIndex: number
  tools: InventoryTool[]
}

interface FoundEvent {
  event: FunnelEvent
  tools: InventoryTool[]
  view: FileView
  offset: number
  via: string
}

/** `currency: "usd"`, `currency = 'EUR'`, `"currency": "GBP"` (a literal three-letter code), in code. */
const CURRENCY_LITERAL = /\b(['"]?)currency\1\s*[:=]\s*(['"`])([A-Za-z]{3})\2/g

const PURCHASE_SUCCESS_ROUTE = /(?:^|\/)(?:success|thank-you|thankyou|thanks|order-confirmation|order-complete|confirmation)(?:\/|$)/i
const CHECKOUT_MARKER = /\b(?:session_id|checkout_session|checkout\.session|payment_intent|stripe|order_id|orderId)\b/

const OUTCOME_EVENT: Partial<Record<OutcomeFinding["kind"], FunnelEvent>> = { signup: "sign_up", lead: "lead", trial: "start_trial", payment_webhook: "purchase" }

function siteKey(site: EventSite): string {
  return `${site.file}\u0000${site.line}`
}

function pushSite(list: EventSite[], site: EventSite): void {
  if (!list.some((entry) => siteKey(entry) === siteKey(site))) list.push(site)
}

function sortSites(sites: EventSite[]): EventSite[] {
  return sites.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

/** The path lists a site keeps its ad pixel (or all tracking) off. */
function restrictedRoutesOf(view: FileView): string[] {
  const out: string[] = []
  for (const match of view.code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*\[/g)) {
    const name = match[1]!
    if (!/(?:restrict|exclud|block|skip|no_?pixel|no_?track|untrack|disallow|deny|without|private)/i.test(name)) continue
    if (!/(?:route|path|page|url)/i.test(name)) continue
    const open = (match.index ?? 0) + match[0].length - 1
    const close = matchingClose(view.code, open)
    if (close < 0) continue
    const items = splitTopLevel(view.code, open + 1, close).map(([from, to]) => view.comments.slice(from, to).trim())
    const paths = items.map((item) => /^(['"`])(\/[^'"`]*)\1$/.exec(item)?.[2] ?? null)
    if (paths.length === 0 || paths.some((path) => path === null)) continue
    out.push(...(paths as string[]))
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// P1-A: how a click leaves the page
// ---------------------------------------------------------------------------------------------

/**
 * A full page load, in code (strings blanked): `location.href = …`, `window.location = …`, `location.assign(…)`. A
 * local variable that happens to be named `location` (`const location = "eu"`) is not one.
 */
const FULL_LOAD_PATTERNS: ReadonlyArray<{ pattern: RegExp; words: string }> = [
  { pattern: /(?<![\w$.]\s*)\b(?:window\s*\.\s*|document\s*\.\s*|globalThis\s*\.\s*)?location\s*\.\s*(assign|replace)\s*\(/, words: "location.$1" },
  { pattern: /(?<![\w$.]\s*)\b(?:window\s*\.\s*|document\s*\.\s*|globalThis\s*\.\s*)?location\s*(?:\.\s*href\s*)?=(?![=>])/, words: "location.href =" },
  { pattern: /\.\s*(?:requestSubmit|submit)\s*\(\s*\)/, words: "a form submit" }
]
/** Client-side routing: the page stays and the router swaps the view. */
const CLIENT_ROUTE_PATTERN = /\b(router|Router|history|navigate)\s*(?:\.\s*(push|replace)\s*)?\(/g

interface Navigation {
  kind: SiteNavigation
  via: string
  /** A literal destination path, when written as one. */
  target: string | null
  /** The element's own default action leaves (a plain link, a form that submits). */
  leavesBy?: "link" | "form"
}

/** A function the site's code calls by name, one level deep: a local one, or one imported from another file. */
type Callee = (view: FileView, name: string) => { view: FileView; fn: FunctionDef } | null

/** A component, a hook or a render body holds handlers; it is not one (`Page`, `useCart`). */
function holdsHandlers(view: FileView, fn: FunctionDef): boolean {
  if (fn.name && (/^[A-Z]/.test(fn.name) || /^use[A-Z]/.test(fn.name))) return true
  const body = view.code.slice(fn.start, fn.end)
  return /\breturn\s*\(?\s*<[A-Za-z>]/.test(body) || (view.code[fn.start - 1] !== "{" && /^\s*\(?\s*<[A-Za-z>]/.test(body))
}

/** The navigation written in one body (strings blanked): a full page load first, then client routing. */
function navigationIn(view: FileView, start: number, end: number): Navigation | null {
  const code = view.code.slice(start, end)
  for (const { pattern, words } of FULL_LOAD_PATTERNS) {
    const match = pattern.exec(code)
    if (match) return { kind: "full_load", via: words.replace("$1", match[1] ?? ""), target: null }
  }
  for (const match of code.matchAll(CLIENT_ROUTE_PATTERN)) {
    const [, object, method] = match
    // `navigate(…)` alone (a router hook), or `router.push` / `router.replace` / `history.push`.
    if (object === "navigate" ? method !== undefined : method === undefined) continue
    const open = start + (match.index ?? 0) + match[0].length - 1
    const target = argAt(view, open + 1)
    return { kind: "client", via: `${object}${method ? `.${method}` : ""}(${target.kind === "literal" ? JSON.stringify(target.value) : "…"})`, target: target.kind === "literal" ? target.value : null }
  }
  return null
}

/** Finding 4: the navigation of a function the handler calls, one level deep (`goToCart()` → `location.assign`). */
function calleeNavigation(view: FileView, fn: FunctionDef, callee: Callee | undefined): Navigation | null {
  if (!callee) return null
  for (const match of view.code.slice(fn.start, fn.end).matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = match[1]!
    if (KEYWORDS.has(name) || name === fn.name) continue
    const found = callee(view, name)
    if (!found || found.fn === fn) continue
    const navigation = navigationIn(found.view, found.fn.start, found.fn.end)
    if (navigation) return { ...navigation, via: `${name}(): ${navigation.via}` }
  }
  return null
}

/** Where the handler is attached: its `onClick={…}` / `onSubmit={…}` attribute (inline, or by the handler's name). */
function handlerAttribute(view: FileView, fn: FunctionDef): { event: "Click" | "Submit"; at: number } | null {
  const before = view.code.slice(Math.max(0, fn.start - 400), fn.start)
  const inline = /\bon(Submit|Click)\s*=\s*\{\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)?\s*(?::[^=]*)?(?:=>\s*)?\{?\s*$/.exec(before)
  if (inline) return { event: inline[1] as "Click" | "Submit", at: fn.start - before.length + inline.index }
  // A named handler (`const handleBuy = …` / `function handleBuy`, or one wrapped in useCallback), used by name.
  const name = fn.name ?? /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:useCallback|useMemo)\s*\(\s*(?:async\s*)?\([^()]*\)\s*(?::[^=]*)?=>\s*\{?\s*$/.exec(before)?.[1]
  if (!name) return null
  const used = new RegExp(`\\bon(Submit|Click)\\s*=\\s*\\{\\s*(?:${name.replace(/\$/g, "\\$")}|(?:\\([^()]*\\)|[A-Za-z_$][\\w$]*)\\s*=>\\s*${name.replace(/\$/g, "\\$")}\\s*\\([^()]*\\))\\s*\\}`).exec(view.code)
  return used ? { event: used[1] as "Click" | "Submit", at: used.index } : null
}

/** Finding 4: what the element the handler is on does by default: a plain link or a form leaves; `<Link>` routes. */
function elementDefault(view: FileView, attribute: { event: "Click" | "Submit"; at: number }): Navigation | null {
  const tag = openTagAround(view.comments, attribute.at)
  if (!tag) return null
  if (/^(?:Link|NextLink|RouterLink|NavLink)$/.test(tag.name)) return { kind: "client", via: `<${tag.name}>`, target: null }
  if (attribute.event === "Submit" && tag.name === "form") return { kind: "full_load", via: "a form post", target: null, leavesBy: "form" }
  if (attribute.event !== "Click") return null
  if (tag.name === "a" && /\bhref\s*=/.test(tag.text)) return { kind: "full_load", via: "a plain link", target: null, leavesBy: "link" }
  const link = enclosingElement(view.comments, attribute.at, "a")
  if (link && /\bhref\s*=/.test(link.text)) return { kind: "full_load", via: "a plain link around the button", target: null, leavesBy: "link" }
  const routerLink = /^(?:Link|NextLink|RouterLink|NavLink)$/.test(tag.name) ? null : ["Link", "NextLink"].map((name) => enclosingElement(view.comments, attribute.at, name)).find(Boolean)
  if (routerLink) return { kind: "client", via: "<Link> around the button", target: null }
  if (tag.name === "button" && !/\btype\s*=\s*\{?\s*["'`](?:button|reset)["'`]/.test(tag.text)) {
    const form = enclosingElement(view.comments, attribute.at, "form")
    if (form) return { kind: "full_load", via: "a form post", target: null, leavesBy: "form" }
  }
  return null
}

/**
 * The handler's navigation after the trigger at `offset`. A full page load or client routing written in the handler
 * (or in a function it calls, one level deep), else what its element does by default. "none" only when the scan KNOWS
 * the page stays (an effect, or a handler that cancels the default and never navigates); null = unknown, never "none".
 */
function navigationAt(view: FileView, offset: number, callee?: Callee): Navigation | null {
  if (view.server) return null
  const chain = enclosing(view, offset)
  if (chain.length === 0) return null
  // The handler: the outermost function that is not a component, a hook or a render body.
  const handler = [...chain].reverse().find((fn) => !holdsHandlers(view, fn)) ?? null
  if (!handler) return null
  // Navigation the code writes wins, in an effect too (a redirect page that adds to the cart and moves on).
  const written = navigationIn(view, handler.start, handler.end) ?? calleeNavigation(view, handler, callee)
  if (written) return written
  const effect = chain.some((fn) => /\buse(?:Layout|Insertion)?Effect\s*\(\s*(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)?\s*=>\s*\{?\s*$/.test(view.code.slice(Math.max(0, fn.start - 80), fn.start)))
  if (effect) return { kind: "none", via: "no navigation (it runs when the page loads, not on a click)", target: null }
  const cancels = /\bpreventDefault\s*\(/.test(view.code.slice(handler.start, handler.end))
  const attribute = handlerAttribute(view, handler)
  const element = attribute && !cancels ? elementDefault(view, attribute) : null
  if (element) return element
  if (cancels) return { kind: "none", via: "no navigation (the handler cancels the default and stays)", target: null }
  return null
}

/**
 * P1-A / Finding 7: the site's own route-change hook that forces a full page load, or null. Only when the location call
 * is inside the hook's OWN callback (`router.events.on("routeChangeStart", cb)`: an inline function, or a function of
 * that name in the same file): a progress bar on the same event beside an unrelated `location.href = "/"` is not one.
 */
function routeChangeFullLoadOf(views: readonly FileView[]): EventSite | null {
  for (const view of views) {
    if (view.server || view.generated) continue
    for (const hook of view.comments.matchAll(/\.\s*on\s*\(\s*(['"`])routeChangeStart\1\s*,/g)) {
      const index = hook.index ?? 0
      if (!isCode(view, index, 1)) continue
      const open = view.comments.indexOf("(", index)
      const args = callArgs(view, open)
      const callback = args[1]
      if (!callback) continue
      const text = view.code.slice(callback[0], callback[1]).trim()
      const named = /^[A-Za-z_$][\w$]*$/.test(text) ? view.functions.find((fn) => fn.name === text) : undefined
      const inline = view.functions.find((fn) => fn.start >= callback[0] && fn.end <= callback[1])
      const body = named ?? inline
      if (!body) continue
      if (!FULL_LOAD_PATTERNS.slice(0, 2).some(({ pattern }) => pattern.test(view.code.slice(body.start, body.end)))) continue
      return { file: view.path, line: lineAt(view, index), via: "routeChangeStart" }
    }
  }
  return null
}

/** A path on a pixel-free route (`/cart`, `/cart/…`). */
function onRoute(routes: readonly string[], path: string): boolean {
  const clean = path.split(/[?#]/)[0] || "/"
  return routes.some((route) => clean === route || clean.startsWith(`${route.replace(/\/$/, "")}/`))
}

/**
 * The site's navigation, settled against its route-change hook: router navigation the site turns into a full page load
 * (into a pixel-free route, or anywhere when the scan cannot tell which) is a full page load.
 */
function settleNavigation(navigation: Navigation | null, hook: EventSite | null, restricted: readonly string[]): Pick<EventSite, "navigation" | "navigationVia" | "leavesBy"> {
  if (!navigation) return {}
  if (navigation.kind === "client" && hook && (navigation.target === null || restricted.length === 0 || onRoute(restricted, navigation.target))) {
    return { navigation: "full_load", navigationVia: `${navigation.via}, which the site turns into a full page load (${hook.file}:${hook.line})`, leavesBy: "route_hook" }
  }
  return { navigation: navigation.kind, navigationVia: navigation.via, ...(navigation.leavesBy ? { leavesBy: navigation.leavesBy } : {}) }
}

// ---------------------------------------------------------------------------------------------
// JSX / HTML elements around an offset
// ---------------------------------------------------------------------------------------------

/** The element tag whose attributes hold `index` (`<form method="POST" action=…>`): its name and its text, or null. */
export function openTagAround(text: string, index: number): { name: string; start: number; text: string } | null {
  let depth = 0
  for (let at = index - 1; at >= Math.max(0, index - 4000); at -= 1) {
    const ch = text[at]!
    if (ch === "}") depth += 1
    else if (ch === "{") depth = Math.max(0, depth - 1)
    else if (depth > 0) continue
    else if (ch === ">" && text[at - 1] !== "=") return null
    else if (ch === "<") {
      const name = /^<([A-Za-z][\w.]*)/.exec(text.slice(at, at + 60))?.[1]
      if (!name) return null
      return { name, start: at, text: text.slice(at, tagEnd(text, at) + 1) }
    }
  }
  return null
}

/** The `>` that closes the tag opening at `start` (braces and `=>` skipped), or the text's end. */
function tagEnd(text: string, start: number): number {
  let depth = 0
  for (let at = start + 1; at < text.length; at += 1) {
    const ch = text[at]!
    if (ch === "{") depth += 1
    else if (ch === "}") depth -= 1
    else if (ch === ">" && depth === 0 && text[at - 1] !== "=") return at
  }
  return text.length - 1
}

/** The innermost still-open `<name …>` element before `index` (its closing tag not yet reached), or null. */
export function enclosingElement(text: string, index: number, name: string): { start: number; text: string } | null {
  const opens = [...text.slice(0, index).matchAll(new RegExp(`<${name}\\b`, "g"))]
  for (let at = opens.length - 1; at >= 0; at -= 1) {
    const start = opens[at]!.index ?? 0
    const end = tagEnd(text, start)
    if (end >= index) continue // `index` is inside this tag's own attributes
    if (text[end - 1] === "/") continue // self-closing
    if (new RegExp(`</${name}\\s*>`).test(text.slice(end, index))) continue
    return { start, text: text.slice(start, end + 1) }
  }
  return null
}

/** A form's method attribute, lower case (HTML's default is GET). */
export function formMethodOf(tag: string): string {
  return /\bmethod\s*=\s*\{?\s*(['"`])(\w+)\1/i.exec(tag)?.[2]?.toLowerCase() ?? "get"
}

// ---------------------------------------------------------------------------------------------
// Finding 1: how a page sends its request to the site's own server route
// ---------------------------------------------------------------------------------------------

/** How the request that starts at the route path's quote (`at`) goes: a form post, a JSON fetch, a link, … */
function requestHowAt(view: FileView, at: number): { how: PageRequestHow; via: string } {
  const before = view.comments.slice(Math.max(0, at - 200), at)
  const attribute = /\b(action|href|formAction)\s*=\s*\{?\s*$/.exec(before)
  if (attribute) {
    if (attribute[1] === "href") return { how: "query", via: "a link" }
    const tag = openTagAround(view.comments, at)
    if (tag?.name === "form") return formMethodOf(tag.text) === "post" ? { how: "form", via: "a form that posts" } : { how: "query", via: "a form that sends a GET" }
    return { how: "unknown", via: "a form button" }
  }
  const call = /\b(fetch|axios(?:\s*\.\s*(get|post|put|patch|delete))?)\s*\(\s*$/.exec(before)
  if (call) {
    const open = at - (before.length - before.lastIndexOf("("))
    const close = matchingClose(view.code, open)
    const args = close < 0 ? "" : view.comments.slice(open, close)
    if (call[1]!.startsWith("axios")) return call[2] === "get" || call[2] === undefined ? { how: "query", via: "a GET request" } : { how: "json", via: "a JSON request" }
    if (/\bJSON\s*\.\s*stringify\s*\(/.test(args)) return { how: "json", via: "a JSON fetch" }
    if (/\bURLSearchParams\b/.test(args)) return { how: "form", via: "a form-encoded fetch" }
    if (!/\bbody\s*:/.test(args)) return { how: "query", via: "a GET fetch" }
    return { how: "unknown", via: "a fetch" }
  }
  if (/(?:(?<![\w$.]\s*)\b(?:window\s*\.\s*)?location(?:\s*\.\s*href)?\s*=|\blocation\s*\.\s*(?:assign|replace)\s*\(|\brouter\s*\.\s*(?:push|replace)\s*\(|\bwindow\s*\.\s*open\s*\(|\bnavigate\s*\()\s*$/.test(before)) return { how: "query", via: "a link" }
  return { how: "unknown", via: "a request the scan could not read" }
}

/** Finding 1: every page that names one of `routes`' URL paths, and how its request goes. */
function pageRequestsOf(views: readonly FileView[], routes: readonly string[], appRoot: string): PageRequest[] {
  const out: PageRequest[] = []
  for (const route of [...new Set(routes)]) {
    const path = routePathOf(route, appRoot)
    if (!path || path === "/" || path.includes("[")) continue
    const pattern = new RegExp(`(['"\`])${escapeRegExp(path)}(?=[?#'"\`]|\\$\\{)`, "g")
    for (const view of views) {
      if (view.server || view.generated) continue
      for (const match of view.comments.matchAll(pattern)) {
        const at = match.index ?? 0
        if (!isCode(view, at, 1)) continue
        const { how, via } = requestHowAt(view, at)
        const line = lineAt(view, at)
        if (!out.some((entry) => entry.route === route && entry.file === view.path && entry.line === line)) out.push({ route, file: view.path, line, how, via })
      }
    }
  }
  return out.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
}

// ---------------------------------------------------------------------------------------------
// P1-B: the page's "visitor allowed tracking" signal
// ---------------------------------------------------------------------------------------------

/** A setter or an action, never a reader (`setConsent`, `acceptTracking`, `trackPageView`). */
const NOT_A_READER = /^(?:set|write|save|store|apply|accept|decline|deny|grant|revoke|withdraw|open|close|show|hide|update|parse|clear|remember|forget|init|initialize|start|stop|on|handle|use|render|track|send|capture|disable|enable|reset|load)[A-Z_]/
/**
 * Finding 5 (privacy): a reader that answers "did the visitor answer / see the banner" is never the signal: true for a
 * visitor who said NO would send their match data to Meta. Any name with one of these words is refused.
 */
const NOT_A_GRANT_WORDS = new Set(["choice", "choices", "answer", "answered", "set", "banner", "open", "opened", "dismiss", "dismissed", "asked", "shown", "seen", "made", "decided", "known"])
/** A boolean reader whose name says the visitor ALLOWED tracking (`trackingAllowed`, `hasMarketingConsent`, `canTrack`). */
const BOOLEAN_READER = /(?:Allowed|Granted|Given|Accepted|Enabled|Ok)$|^(?:has|is|can)(?:[A-Z][a-z]+)*(?:Consent|Consented|Track|Tracking)$/
/** A reader that returns the stored consent STATE (`getConsent()` → "granted" | "denied"), compared with its yes word. */
const STATE_READER = /^(?:get|read|current)\w*Consent\w*$|^(?:consent|cookieConsent|trackingConsent)(?:State|Status|Value)?$/
const GRANTED_WORDS = ["granted", "accepted", "allowed", "accept", "allow", "all", "yes"] as const

/** The camel-case words of a name, lower case (`hasConsentChoice` → has, consent, choice). */
function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase().split(/\s+/).filter(Boolean)
}

/** The string literals a type annotation allows: `"granted" | "denied"`, or a same-file `type X = "a" | "b"` it names. */
function annotationLiterals(view: FileView, annotation: string): string[] {
  const literal = (text: string) => [...text.matchAll(/(['"`])([^'"`]*)\1/g)].map((match) => match[2]!)
  if (/['"`]/.test(annotation)) return literal(annotation)
  const name = /^([A-Za-z_$][\w$]*)(?:\s*\|\s*(?:null|undefined))*$/.exec(annotation.trim())?.[1]
  if (!name) return []
  const alias = new RegExp(`\\btype\\s+${name.replace(/\$/g, "\\$")}\\s*=\\s*([^;\\n]+)`).exec(view.comments)
  return alias ? literal(alias[1]!) : []
}

/**
 * Finding 5: the values a state reader can return, from the reader's OWN code, never the whole file (a Consent Mode
 * `'granted'` elsewhere in the file is not what it returns): the literals of its return type, the literals in its body,
 * and, when it returns a stored value (`localStorage.getItem(KEY)`, a cookie), the literals the file stores under that
 * same key.
 */
function readerValues(view: FileView, fn: FunctionDef, annotation: string): string[] {
  const values = new Set(annotationLiterals(view, annotation))
  const body = view.comments.slice(fn.start, fn.end)
  for (const match of body.matchAll(/(['"`])([A-Za-z_-]{1,20})\1/g)) values.add(match[2]!)
  for (const match of body.matchAll(/\bgetItem\s*\(\s*([^)]+?)\s*\)/g)) {
    const key = match[1]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    for (const stored of view.comments.matchAll(new RegExp(`\\bsetItem\\s*\\(\\s*${key}\\s*,\\s*(['"\`])([^'"\`]*)\\1`, "g"))) values.add(stored[2]!)
  }
  return [...values]
}

/** The reader returns a boolean although its name reads as a state (`return localStorage.getItem("c") === "yes"`). */
function returnsBoolean(view: FileView, fn: FunctionDef): boolean {
  const body = view.code.slice(fn.start, fn.end)
  const returns = view.code[fn.start - 1] === "{" ? [...body.matchAll(/\breturn\b([^;\n]*)/g)].map((match) => match[1]!.trim()) : [body.trim()]
  return returns.length > 0 && returns.every((expression) => /^(?:true|false)$|^!|[=!]==?|[<>]=?/.test(expression) && !/\?/.test(expression))
}

/** P1-B: the site's own exported consent reader the page can call with no arguments, as the signal's expression. */
function siteConsentReaderOf(views: readonly FileView[]): Extract<TrackingSignal, { kind: "site_getter" }> | null {
  const found: Array<Extract<TrackingSignal, { kind: "site_getter" }> & { rank: number }> = []
  for (const view of [...views].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (view.server || view.generated || !isCodeFile(view.path)) continue
    const exports = [
      ...view.code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g),
      ...view.code.matchAll(/\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?\(/g)
    ]
    for (const match of exports) {
      const name = match[1]!
      if (NOT_A_READER.test(name) || !/consent|tracking|track|marketing|cookie/i.test(name)) continue
      if (nameWords(name).some((word) => NOT_A_GRANT_WORDS.has(word))) continue
      const boolean = BOOLEAN_READER.test(name)
      if (!boolean && !STATE_READER.test(name)) continue
      const open = (match.index ?? 0) + match[0].length - 1
      const close = matchingClose(view.code, open)
      if (close < 0) continue
      // Callable with no arguments: every parameter optional or defaulted.
      const params = splitTopLevel(view.code, open + 1, close).map(([from, to]) => view.code.slice(from, to).trim())
      if (params.some((param) => param !== "" && !/^[A-Za-z_$][\w$]*\s*\?\s*:|=/.test(param))) continue
      // Read with strings kept (a `"granted" | "denied"` annotation is literals).
      const annotation = /^\s*:\s*([^{=]*?)\s*(?:=>|\{)/.exec(view.comments.slice(close + 1, close + 200))?.[1]?.trim() ?? ""
      const fn = view.functions.find((candidate) => candidate.name === name && candidate.start > close)
      let expression: string | null = null
      if (annotation === "boolean" || (boolean && annotation === "")) expression = `${name}()`
      else if (!boolean && fn) {
        if (annotation === "" && returnsBoolean(view, fn)) expression = `${name}()`
        else {
          // A state reader: compared with the value IT returns when the visitor said yes (unsure: not this reader).
          const values = readerValues(view, fn, annotation)
          const word = GRANTED_WORDS.find((candidate) => values.includes(candidate))
          if (word) expression = `${name}() === ${JSON.stringify(word)}`
        }
      }
      if (!expression) continue
      found.push({ kind: "site_getter", expression, name, file: view.path, line: lineAt(view, match.index ?? 0), rank: boolean ? (/track|marketing/i.test(name) ? 0 : 1) : 2 })
    }
  }
  const best = found.sort((a, b) => a.rank - b.rank)[0]
  if (!best) return null
  const { rank: _rank, ...signal } = best
  return signal
}

/** P1-B: the site's tracking signal (its own reader; `true` with no consent gate at all; else the tag's helper). */
function trackingSignalOf(views: readonly FileView[]): TrackingSignal {
  const reader = siteConsentReaderOf(views)
  if (reader) return reader
  const gate = views.some((view) => !view.server && !view.generated && (isConsentFile(view.path) || isConsentText(view.text)))
  return gate ? { kind: "tag_helper" } : { kind: "always" }
}

/** Pure: the event × tool inventory of a snapshot. `outcomes` defaults to `detectOutcomes(snapshot)`. */
export function buildEventInventory(snapshot: RepoSnapshot, outcomes: readonly OutcomeFinding[] = detectOutcomes(snapshot)): EventInventory {
  const views: FileView[] = []
  for (const [path, text] of snapshot.files) {
    if (isNonProductPath(path) || !(isCodeFile(path) || isHtmlFile(path))) continue
    views.push(viewOf(path, text))
  }
  const imports = new Map(views.map((view) => [view.path, importsOf(view, snapshot.files)]))
  const found: FoundEvent[] = []

  // A send whose name is a parameter of an enclosing (named) function makes that function a sender.
  const senders = new Map<string, Sender>() // `${file}\0${name}`
  const learn = (view: FileView, offset: number, ident: string, tools: readonly InventoryTool[]): boolean => {
    if (view.generated) return false
    for (const fn of enclosing(view, offset)) {
      const argIndex = fn.params.indexOf(ident)
      if (argIndex < 0) continue
      if (fn.name === null) return false
      const key = `${view.path}\u0000${fn.name}`
      const existing = senders.get(key)
      if (existing) {
        const before = existing.tools.length
        for (const tool of tools) if (!existing.tools.includes(tool)) existing.tools.push(tool)
        return existing.tools.length !== before
      }
      senders.set(key, { file: view.path, name: fn.name, argIndex, tools: [...tools] })
      return true
    }
    return false
  }
  const record = (view: FileView, offset: number, arg: Arg, tools: readonly InventoryTool[], via: string) => {
    if (arg.kind !== "literal") return
    const event = funnelEventOf(arg.value)
    if (event) found.push({ event, tools: [...tools], view, offset, via })
  }

  for (const view of views) {
    for (const call of rawCallsOf(view)) {
      const name = nameArg(view, call)
      if (!name) continue
      if (name.arg.kind === "ident") learn(view, call.openParen, name.arg.value, call.tools)
      else record(view, call.openParen, name.arg, call.tools, call.via)
    }
  }

  // The outcome helper's recipe reporters name their conversion themselves (a Stripe purchase, a checkout start, a
  // lead): server code only, the same tools as any outcome.
  for (const view of views) {
    if (!view.server || view.generated) continue
    for (const outcome of outcomesIn(view.path, view.text)) {
      if (outcome.reporter.defaultType === null || outcome.type === null) continue
      record(view, outcome.call.index, { kind: "literal", value: outcome.type }, ["infinite", "meta_server"], "reportInfiniteOutcome")
    }
  }

  // Follow the site's own senders to a fixed point (bounded): `track(name)` → `trackGoogleEvent(name)` → gtag.
  const seenCalls = new Set<string>()
  for (let round = 0; round < 5; round += 1) {
    let learned = false
    for (const sender of [...senders.values()]) {
      for (const view of views) {
        const local = view.path === sender.file && view.functions.some((fn) => fn.name === sender.name)
        const imported = imports.get(view.path)?.get(sender.name) === sender.file
        if (!local && !imported) continue
        for (const match of view.comments.matchAll(new RegExp(`(?<![\\w$.])${sender.name.replace(/\$/g, "\\$")}\\s*(?:<[^>()]*>)?\\s*\\(`, "g"))) {
          const index = match.index ?? 0
          if (!isCode(view, index, sender.name.length)) continue
          if (/\bfunction\s*\*?\s*$/.test(view.code.slice(Math.max(0, index - 20), index))) continue
          const openParen = index + match[0].length - 1
          // A method definition `name(params) {` is not a call.
          const close = matchingClose(view.code, openParen)
          if (close > 0 && /^\s*(?::\s*[^{;=]*?)?\s*\{/.test(view.code.slice(close + 1, close + 100)) && !/[=(,:?]\s*$/.test(view.code.slice(Math.max(0, index - 10), index))) continue
          const key = `${sender.file}\u0000${sender.name}\u0000${view.path}\u0000${openParen}\u0000${sender.tools.join(",")}`
          if (seenCalls.has(key)) continue
          seenCalls.add(key)
          const name = nameArg(view, { openParen, argIndex: sender.argIndex })
          if (!name) continue
          if (name.arg.kind === "ident") learned = learn(view, openParen, name.arg.value, sender.tools) || learned
          else record(view, openParen, name.arg, sender.tools, `helper:${sender.name}`)
        }
      }
    }
    if (!learned) break
  }

  // P1-A: the pixel-free routes and the site's own route-change hook decide whether a router navigation leaves the page.
  const restricted = new Set<string>()
  for (const view of views) for (const path of restrictedRoutesOf(view)) restricted.add(path)
  const routeChangeFullLoad = routeChangeFullLoadOf(views)
  // Finding 4: a handler's own helper call is followed one level (`goToCart()` → `location.assign`), locally or imported.
  const callee: Callee = (view, name) => {
    const local = view.functions.find((fn) => fn.name === name)
    if (local) return { view, fn: local }
    const from = imports.get(view.path)?.get(name)
    const other = from ? views.find((candidate) => candidate.path === from) : undefined
    const fn = other?.functions.find((candidate) => candidate.name === name)
    return other && fn ? { view: other, fn } : null
  }
  const leaves = (view: FileView, offset: number) => settleNavigation(navigationAt(view, offset, callee), routeChangeFullLoad, [...restricted])

  // Trigger sites: the callers of the event helper holding a send (one level), else the send itself.
  const entries = new Map<FunnelEvent, EventInventoryEntry>()
  const entryOf = (event: FunnelEvent): EventInventoryEntry => {
    let entry = entries.get(event)
    if (!entry) {
      entry = { event, sites: [], tools: {}, missing: [] }
      entries.set(event, entry)
    }
    return entry
  }
  const helperCallers = new Map<string, EventSite[]>()
  const callersOf = (view: FileView, helper: FunctionDef & { name: string }): EventSite[] => {
    const key = `${view.path}\u0000${helper.name}`
    const cached = helperCallers.get(key)
    if (cached) return cached
    const sites: EventSite[] = []
    for (const other of views) {
      const local = other.path === view.path
      const imported = imports.get(other.path)?.get(helper.name) === view.path
      if (!local && !imported) continue
      for (const match of other.comments.matchAll(new RegExp(`(?<![\\w$.])${helper.name.replace(/\$/g, "\\$")}\\s*\\(`, "g"))) {
        const index = match.index ?? 0
        if (!isCode(other, index, helper.name.length)) continue
        if (/\bfunction\s*\*?\s*$/.test(other.code.slice(Math.max(0, index - 20), index))) continue
        const openParen = index + match[0].length - 1
        const close = matchingClose(other.code, openParen)
        if (close > 0 && /^\s*(?::\s*[^{;=]*?)?\s*\{/.test(other.code.slice(close + 1, close + 100)) && !/[=(,:?]\s*$/.test(other.code.slice(Math.max(0, index - 10), index))) continue
        // The helper's own body is not a caller of itself.
        if (local && view.functions.some((fn) => fn.name === helper.name && fn.start <= index && index < fn.end)) continue
        pushSite(sites, { file: other.path, line: lineAt(other, index), via: `helper:${helper.name}`, ...leaves(other, index), helperAt: { file: view.path, line: helperLine(view, helper) } })
      }
    }
    helperCallers.set(key, sites)
    return sites
  }
  const isSenderName = (file: string, name: string) => senders.has(`${file}\u0000${name}`)
  for (const send of found) {
    const entry = entryOf(send.event)
    const site: EventSite = { file: send.view.path, line: lineAt(send.view, send.offset), via: send.via }
    for (const tool of send.tools) pushSite((entry.tools[tool] ??= []), site)
    const helper = enclosing(send.view, send.offset).find((fn): fn is FunctionDef & { name: string } => fn.name !== null && !isSenderName(send.view.path, fn.name))
    const callers = helper ? callersOf(send.view, helper) : []
    if (callers.length > 0) for (const caller of callers) pushSite(entry.sites, caller)
    else pushSite(entry.sites, { ...site, ...leaves(send.view, send.offset) })
  }

  // Server facts.
  const checkoutCreates: EventSite[] = []
  for (const view of views) {
    if (!view.server) continue
    for (const match of view.comments.matchAll(/\.\s*checkout\s*\.\s*sessions\s*\.\s*create\s*\(/g)) {
      const index = match.index ?? 0
      if (!isCode(view, index, match[0].length - 1)) continue
      pushSite(checkoutCreates, { file: view.path, line: lineAt(view, index), via: "stripe.checkout.sessions.create" })
    }
  }
  for (const site of checkoutCreates) pushSite(entryOf("begin_checkout").sites, site)

  const webhooks = outcomes.filter((finding) => finding.kind === "payment_webhook")
  const paymentWebhook: EventSite | null = webhooks[0] ? { file: webhooks[0].file, line: webhooks[0].line, via: "payment-webhook" } : null
  for (const finding of outcomes) {
    const event = OUTCOME_EVENT[finding.kind]
    if (!event) continue
    pushSite(entryOf(event).sites, { file: finding.file, line: finding.line, via: finding.kind === "payment_webhook" ? "payment-webhook" : "form-api" })
  }

  // Success pages: a page on a success / thank-you route that reads the order (or fires the purchase).
  for (const view of views) {
    if (view.server || !isCodeFile(view.path)) continue
    const route = routePathOf(view.path, snapshot.appRoot)
    if (!route || !PURCHASE_SUCCESS_ROUTE.test(route)) continue
    const purchaseHere = found.some((send) => send.event === "purchase" && send.view.path === view.path) || (entries.get("purchase")?.sites ?? []).some((site) => site.file === view.path)
    const marker = CHECKOUT_MARKER.exec(view.comments)
    if (!purchaseHere && !marker && checkoutCreates.length === 0) continue
    const entry = entryOf("purchase")
    if (!entry.sites.some((site) => site.file === view.path)) pushSite(entry.sites, { file: view.path, line: marker ? lineAt(view, marker.index) : 1, via: "success-page" })
  }
  // A checkout session with no webhook and no success page still means a purchase happens (on the provider's page).
  if (checkoutCreates.length > 0 && !entries.has("purchase")) for (const site of checkoutCreates) pushSite(entryOf("purchase").sites, site)

  // The site's currency: what its checkout charges in, else the one its code names.
  const checkoutCurrencies = new Set<string>()
  const codeCurrencies = new Set<string>()
  const checkoutFiles = new Set(checkoutCreates.map((site) => site.file))
  for (const view of views) {
    if (view.generated) continue
    for (const match of view.comments.matchAll(CURRENCY_LITERAL)) {
      if (!isCode(view, match.index ?? 0, "currency".length)) continue
      const code = match[3]!.toUpperCase()
      codeCurrencies.add(code)
      if (checkoutFiles.has(view.path)) checkoutCurrencies.add(code)
    }
  }
  const siteCurrency = checkoutCurrencies.size === 1 ? [...checkoutCurrencies][0]! : codeCurrencies.size === 1 ? [...codeCurrencies][0]! : null

  const events: EventInventoryEntry[] = []
  for (const event of FUNNEL_EVENTS) {
    const entry = entries.get(event)
    if (!entry) continue
    sortSites(entry.sites)
    const tools: Partial<Record<InventoryTool, EventSite[]>> = {}
    for (const tool of INVENTORY_TOOLS) if (entry.tools[tool]?.length) tools[tool] = sortSites([...entry.tools[tool]!])
    entry.tools = tools
    entry.missing = EXPECTED_TOOLS[event].filter((tool) => !tools[tool]?.length)
    events.push(entry)
  }
  return {
    events,
    checkoutCreates: sortSites(checkoutCreates),
    paymentWebhook,
    pixelRestrictedRoutes: [...restricted].sort(),
    routeChangeFullLoad,
    pageRequests: pageRequestsOf(views, [...checkoutCreates.map((site) => site.file), ...outcomes.filter((finding) => OUTCOME_EVENT[finding.kind] && finding.kind !== "payment_webhook").map((finding) => finding.file)], snapshot.appRoot),
    trackingSignal: trackingSignalOf(views),
    siteCurrency
  }
}

/** The inventory entry of one event, or null. */
export function inventoryEntry(inventory: EventInventory | null | undefined, event: FunnelEvent): EventInventoryEntry | null {
  return inventory?.events.find((entry) => entry.event === event) ?? null
}
