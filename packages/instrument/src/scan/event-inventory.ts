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
//     `const META_RESTRICTED_ROUTES = ["/cart", "/success"]`).
//
// Pure: a function of a RepoSnapshot. Comments never count; tests, fixtures and mocks are never evidence; the
// wizard's own generated helpers (`infinite-*` files) are never read as the site's senders.
import { posix } from "node:path"

import { codeView, isCodeFile, isHtmlFile, isNonProductPath, routePathOf } from "../jobs/detectors/shared.js"
import { detectOutcomes, isServerFile, type OutcomeFinding } from "../jobs/detectors/outcomes.js"
import type { RepoSnapshot } from "../jobs/repo-files.js"

export type InventoryTool = "ga4" | "posthog" | "meta_browser" | "meta_server" | "infinite"
export type FunnelEvent = "view_item" | "add_to_cart" | "begin_checkout" | "purchase" | "lead" | "sign_up" | "start_trial"
export interface EventSite { file: string; line: number; via: string } // via: "gtag", "posthog.capture", "fbq", "dataLayer", "helper:<fn>", "stripe.checkout.sessions.create", "success-page", "form-api", …
export interface EventInventoryEntry { event: FunnelEvent; sites: EventSite[]; tools: Partial<Record<InventoryTool, EventSite[]>>; missing: InventoryTool[] }
export interface EventInventory { events: EventInventoryEntry[]; checkoutCreates: EventSite[]; paymentWebhook: EventSite | null; pixelRestrictedRoutes: string[] }

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
  { pattern: /\b(?:reportInfiniteOutcome|postInfiniteOutcome)\s*\(/g, tools: ["infinite", "meta_server"], via: "reportInfiniteOutcome", argIndex: () => 0, objectKey: "type" },
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
  for (const match of view.comments.matchAll(/\binfiniteTrack(ThenNavigate)?\s*\(/g)) {
    const index = match.index ?? 0
    const paren = index + match[0].length - 1
    if (!isCode(view, index, paren - index)) continue
    const close = matchingClose(view.code, paren)
    const callText = close < 0 ? "" : view.comments.slice(paren, close)
    const destinations = /\bdestinations\s*:\s*\{([^}]*)\}/.exec(callText)?.[1]
    const on = (key: string) => (destinations ? new RegExp(`\\b${key}\\s*:\\s*true\\b`).test(destinations) : null)
    const tools: InventoryTool[] = []
    for (const [key, tool] of [["ga4", "ga4"], ["posthog", "posthog"]] as const) if (on(key) ?? true) tools.push(tool)
    if (on("meta") === true || /\bmetaEventName\s*:/.test(callText)) tools.push("meta_browser")
    calls.push({ tools, via: match[1] ? "infiniteTrackThenNavigate" : "infiniteTrack", openParen: paren, argIndex: match[1] ? 2 : 0 })
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
  const callersOf = (view: FileView, helper: string): EventSite[] => {
    const key = `${view.path}\u0000${helper}`
    const cached = helperCallers.get(key)
    if (cached) return cached
    const sites: EventSite[] = []
    for (const other of views) {
      const local = other.path === view.path
      const imported = imports.get(other.path)?.get(helper) === view.path
      if (!local && !imported) continue
      for (const match of other.comments.matchAll(new RegExp(`(?<![\\w$.])${helper.replace(/\$/g, "\\$")}\\s*\\(`, "g"))) {
        const index = match.index ?? 0
        if (!isCode(other, index, helper.length)) continue
        if (/\bfunction\s*\*?\s*$/.test(other.code.slice(Math.max(0, index - 20), index))) continue
        const openParen = index + match[0].length - 1
        const close = matchingClose(other.code, openParen)
        if (close > 0 && /^\s*(?::\s*[^{;=]*?)?\s*\{/.test(other.code.slice(close + 1, close + 100)) && !/[=(,:?]\s*$/.test(other.code.slice(Math.max(0, index - 10), index))) continue
        // The helper's own body is not a caller of itself.
        if (local && view.functions.some((fn) => fn.name === helper && fn.start <= index && index < fn.end)) continue
        pushSite(sites, { file: other.path, line: lineAt(other, index), via: `helper:${helper}` })
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
    const helper = enclosing(send.view, send.offset).find((fn) => fn.name !== null && !isSenderName(send.view.path, fn.name))
    const callers = helper?.name ? callersOf(send.view, helper.name) : []
    if (callers.length > 0) for (const caller of callers) pushSite(entry.sites, caller)
    else pushSite(entry.sites, site)
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

  const restricted = new Set<string>()
  for (const view of views) for (const path of restrictedRoutesOf(view)) restricted.add(path)

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
  return { events, checkoutCreates: sortSites(checkoutCreates), paymentWebhook, pixelRestrictedRoutes: [...restricted].sort() }
}

/** The inventory entry of one event, or null. */
export function inventoryEntry(inventory: EventInventory | null | undefined, event: FunnelEvent): EventInventoryEntry | null {
  return inventory?.events.find((entry) => entry.event === event) ?? null
}
