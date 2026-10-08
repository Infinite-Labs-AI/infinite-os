// The commerce and conversion static checks: after the agent's turns, does the code really send what the plan
// promised, to each tool, once, with the money and the match data Meta needs?
//
// Why it exists (review r3, "static checks / prove"): a run that left Meta with PageView only, or with no Purchase,
// was never flagged. The old checks looked at one job's files for one call shape; nothing compared the code with the
// plan's event × tool promises, nothing caught a second GA4 `purchase` beside the site's own, and the personal-data
// check flagged `email:` inside a hashing call whose result carries digests only.
//
// Each rule below reads source (comments never count; strings only where a name is read) and returns findings in
// plain words: they become the check's reason, the job note and the reviewer agent's input.
//   promise_missing        — an event × tool cell the plan promised (`will_add`) has no matching code: no Meta
//                            ViewContent / AddToCart send, no `reportInfiniteOutcome` for a server event, no GA4 /
//                            PostHog / Infinite send for an event promised to them;
//   outcome_without_ad_match — an outcome for an event Meta gets from the server, with no `adMatch`;
//   tracking_signal_not_carried — Finding 1: the page that sends a server conversion's request carries no tracking
//                            signal, one not built from the site's signal, or one the route reads from another place
//                            or under another key (so the conversion reaches Meta with no match data);
//   purchase_without_value — a purchase outcome without its value and currency;
//   double_count           — the turn added a send of an event a tool already gets from the site (a new
//                            `gtag('event', X)`, `posthog.capture(X)`, `infiniteTrack(X)` that reaches GA4/PostHog, …);
//   sent_twice_on_one_click — P1-A: one click reaches two sends of the same browser event to one tool (a send inside
//                            the site's helper AND another in the handler that calls it, or two helpers that both send);
//   lost_before_leaving    — P1-A: a click the scan saw leave with a FULL page load reaches a browser Meta send that
//                            nothing waits for (no infiniteLeaveAfter / infiniteTrackThenNavigate / returned wait), so
//                            the page can unload before Meta has it;
//   code_after_return      — Finding 3: a function the run changed returns before code that then never runs (a helper
//                            that returns the wait first loses its own GA4 and PostHog sends below it);
//   lead_may_send_nothing  — P2-7: `reportInfiniteLead` without a `fallbackId` reports nothing until LEAD_ID_SECRET is set;
//   page_built_meta_event_id — a browser Meta event carries an event id that is not the one the server got back;
//   pii_in_outcome / pii_in_stripe_metadata — a raw email, name, address or any phone reaches an outcome's request
//                            body or Stripe metadata. Only what REACHES the body counts: the arguments of a call
//                            inside it (`withPerson({ email })`, `adMatchFromRequest(req, { email })`) are inputs to a
//                            function whose RESULT is sent, so they are not flagged; a phone is flagged anywhere.
import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { lineNumberAt } from "../harness/scan.js"
import { isServerFile } from "../jobs/detectors/outcomes.js"
import { findEventIdHits } from "../setup-checks/meta-event-id.js"
import { alreadySentOf, promisesOf, INVENTORY_EVENTS, type EventInventory, type InventoryEvent, type InventoryTool } from "./commerce-inventory.js"
import { callsOf, closingOf, literalString, objectProps, splitTopLevelArgs, topLevelProps, type Call } from "./source-calls.js"

// ---------------------------------------------------------------------------------------------
// Event names
// ---------------------------------------------------------------------------------------------

/** Every name a site, GA4, PostHog or Meta uses for one event, in snake case. */
const EVENT_ALIASES: Readonly<Record<InventoryEvent, readonly string[]>> = {
  view_item: ["view_item", "view_content", "viewcontent", "product_viewed", "product_view", "view_product", "viewed_product", "item_viewed"],
  add_to_cart: ["add_to_cart", "addtocart", "product_added", "product_added_to_cart", "added_to_cart", "cart_add", "add_cart"],
  begin_checkout: ["begin_checkout", "initiate_checkout", "initiatecheckout", "checkout_started", "start_checkout", "started_checkout"],
  purchase: ["purchase", "purchase_completed", "order_completed", "order_placed", "checkout_completed", "completed_purchase"],
  lead: ["lead", "generate_lead", "mailing_list_joined", "newsletter_signup", "newsletter_subscribed", "waitlist_joined", "waitlist_signup", "subscribed_to_newsletter"],
  sign_up: ["sign_up", "signup", "complete_registration", "completeregistration", "registration_complete", "account_created", "user_signed_up"],
  start_trial: ["start_trial", "starttrial", "trial_started", "trial_start"]
}

/** Meta's standard name for each event. */
export const META_EVENT_NAMES: Readonly<Record<InventoryEvent, string>> = {
  view_item: "ViewContent",
  add_to_cart: "AddToCart",
  begin_checkout: "InitiateCheckout",
  purchase: "Purchase",
  lead: "Lead",
  sign_up: "CompleteRegistration",
  start_trial: "StartTrial"
}

const TOOL_WORDS: Readonly<Record<InventoryTool, string>> = { meta: "Meta", ga4: "GA4", posthog: "PostHog", infinite: "Infinite" }

/** The event a site, GA4, PostHog or Meta name stands for (`AddToCart`, `product_added` → add_to_cart), else null. */
export function canonicalEvent(name: string): InventoryEvent | null {
  const key = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  for (const event of INVENTORY_EVENTS) if (EVENT_ALIASES[event].includes(key)) return event
  return null
}

// ---------------------------------------------------------------------------------------------
// Sends: which tool gets which event, from which line
// ---------------------------------------------------------------------------------------------

export interface Send {
  tool: InventoryTool
  event: InventoryEvent
  /** The name as written (`product_added`, `AddToCart`). */
  name: string
  file: string
  line: number
  /** What sends it: `gtag`, `posthog.capture`, `fbq`, `infiniteTrack`, or the site's own wrapper's name. */
  via: string
  /** The offset of the send in the file's text. */
  index?: number
}

/** The site's own wrappers, by name: `sendGa("x")`, `trackGoogleEvent("x")`, `capturePosthog("x")`, `trackMetaEvent("X")`. */
const WRAPPER_TOOLS: ReadonlyArray<{ tool: InventoryTool; pattern: RegExp }> = [
  { tool: "ga4", pattern: /^(?:ga4?|gtag|google)(?:[A-Z_]|$)|[a-z](?:Ga4?|GA4?|Gtag|Google)(?:[A-Z_]|$)/ },
  { tool: "posthog", pattern: /posthog/i },
  { tool: "meta", pattern: /^(?:meta|fb|pixel|facebook)(?:[A-Z_]|$)|[a-z](?:Meta|Fb|Fbq|Pixel|Facebook)(?:[A-Z_]|$)/ }
]
/** Never a wrapper: the tools' own functions (read on their own) and the tag's helpers. */
const NOT_A_WRAPPER = /^(?:gtag|fbq|infiniteTrack|infiniteTrackBeforeLeaving|infiniteTrackThenNavigate|infiniteLeaveAfter|infiniteMetaMirror|reportInfiniteOutcome|postInfiniteOutcome)$/

/**
 * The tool is skipped by the options argument (`conversions/track.ts`): `destinations: { ga4: false }` turns one off, and
 * `destinations: ["meta"]` (a list, or `tools:`) sends to exactly the tools it names.
 */
function destinationOff(options: string, tool: InventoryTool): boolean {
  const list = /(?:destinations|tools)\s*:\s*\[([^\]]*)\]/.exec(options)
  if (list) return !new RegExp(`(['"\`])${tool}\\1`).test(list[1]!)
  return new RegExp(`(?:destinations|tools)\\s*:\\s*\\{[^}]*\\b${tool}\\s*:\\s*false\\b`).test(options)
}

/** An options argument passed by name (`META_ONLY`): the object literal a `const` of that name holds in the same file. */
function namedObject(text: string, name: string): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return null
  const masked = maskCommentsAndStrings(text, true)
  const declared = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*\\{`).exec(masked)
  if (!declared) return null
  const open = declared.index + declared[0].length - 1
  const close = closingOf(masked, open)
  return close < 0 ? null : text.slice(open, close + 1)
}

/** The tag's `infiniteTrack(name, props, options)` / `infiniteTrackBeforeLeaving(…)` / `infiniteTrackThenNavigate(…)`: the tools it reaches. */
function helperSends(call: Call, file: string, text: string): Send[] {
  const parts = splitTopLevelArgs(call.args)
  const first = call.name === "infiniteTrack" || call.name === "infiniteTrackBeforeLeaving"
  let name: string | null = null
  if (first) name = parts[0] !== undefined ? literalString(parts[0]) : null
  else for (const part of parts) {
    const value = literalString(part)
    if (value !== null && /^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
      name = value
      break
    }
  }
  if (name === null) return []
  const raw = first ? (parts[2] ?? "") : (parts.filter((part) => part.trim().startsWith("{")).pop() ?? "")
  const options = maskCommentsAndStrings(namedObject(text, raw.trim()) ?? raw, false)
  const metaName = /\bmetaEventName\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(options)?.[1] ?? null
  const event = canonicalEvent(name)
  const line = lineNumberAt(text, call.index)
  const out: Send[] = []
  if (event !== null) {
    for (const tool of ["ga4", "posthog", "infinite"] as const) if (!destinationOff(options, tool)) out.push({ tool, event, name, file, line, via: call.name, index: call.index })
  }
  const metaEvent = metaName !== null ? canonicalEvent(metaName) : event
  if (metaEvent !== null && (metaEvent === "view_item" || metaEvent === "add_to_cart") && !destinationOff(options, "meta")) {
    out.push({ tool: "meta", event: metaEvent, name: metaName ?? META_EVENT_NAMES[metaEvent], file, line, via: call.name, index: call.index })
  }
  return out
}

/** Every send of a known event in one file, per tool. */
export function sendsIn(file: string, text: string): Send[] {
  const out: Send[] = []
  const add = (tool: InventoryTool, name: string | null, index: number, via: string) => {
    if (name === null) return
    const event = canonicalEvent(name)
    if (event !== null) out.push({ tool, event, name, file, line: lineNumberAt(text, index), via, index })
  }
  for (const call of callsOf(text, ["gtag"])) {
    const [kind, name] = splitTopLevelArgs(call.args)
    if (kind !== undefined && literalString(kind) === "event" && name !== undefined) add("ga4", literalString(name), call.index, "gtag")
  }
  const commentsOnly = maskCommentsAndStrings(text, false)
  const masked = maskCommentsAndStrings(text, true)
  // A gtag reached through a getter: `ensureGtag()("event", "x", …)`.
  for (const match of commentsOnly.matchAll(/\)\s*\(\s*(["'])event\1\s*,\s*(["'])([A-Za-z0-9_$]+)\2/g)) {
    const before = commentsOnly.slice(Math.max(0, (match.index ?? 0) - 40), match.index ?? 0)
    if (/gtag\s*\([^()]*$/i.test(before) || /Gtag\s*\(\s*$/.test(before)) add("ga4", match[3]!, match.index ?? 0, "gtag")
  }
  for (const call of callsOf(text, ["posthog.capture"])) {
    const [name] = splitTopLevelArgs(call.args)
    if (name !== undefined) add("posthog", literalString(name), call.index, "posthog.capture")
  }
  for (const call of callsOf(text, ["fbq"])) {
    const parts = splitTopLevelArgs(call.args)
    const method = parts[0] !== undefined ? literalString(parts[0]) : null
    const name = method === "track" || method === "trackCustom" ? parts[1] : method === "trackSingle" || method === "trackSingleCustom" ? parts[2] : undefined
    if (name !== undefined) add("meta", literalString(name), call.index, "fbq")
  }
  for (const call of callsOf(text, ["infiniteTrack", "infiniteTrackBeforeLeaving", "infiniteTrackThenNavigate"])) out.push(...helperSends(call, file, text))
  // The site's own wrappers, called with a literal event name.
  for (const match of commentsOnly.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(\s*(["'])([A-Za-z0-9_$]+)\2/g)) {
    const ident = match[1]!
    if (NOT_A_WRAPPER.test(ident) || /^(?:function|if|for|while|switch|return|typeof)$/.test(ident)) continue
    const index = match.index ?? 0
    if (masked.slice(index, index + ident.length) !== ident) continue
    // A declaration (`function sendGa(…)`) is not a call.
    if (/\bfunction\s*$/.test(commentsOnly.slice(Math.max(0, index - 12), index))) continue
    const wrapper = WRAPPER_TOOLS.find((entry) => entry.pattern.test(ident))
    if (wrapper) add(wrapper.tool, match[3]!, index, ident)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * Every server-lane call that reports a conversion to Infinite, and what each one carries by itself. The outcome
 * helper (`lib/infinite-outcome`, `server-lane/targets/outcome-helper.ts`) exports the generic reporters, which take
 * ONE outcome object, and the recipe reporters, which build the outcome themselves:
 *   reportStripeCheckoutPurchase(event, { path, type? })   → purchase: value, currency, content ids, a stable event id
 *                                                            (the session id) and the PAYER's match data, all inside;
 *   reportStripeCheckoutStarted(session, { path, type? })  → begin_checkout: value, currency and the device match data
 *                                                            the checkout saved on the session (contextMetadata), inside;
 *   reportInfiniteLead(req, { email, trackingAllowed, type?, path?, fallbackPath?, properties? })
 *                                                          → lead (or its `type`): one stable id per person, the path
 *                                                            from the page, the hashed email and the device match data,
 *                                                            inside. Its `email` is an INPUT that is hashed there.
 */
export interface OutcomeReporter {
  /** Which argument holds the object the wizard reads (the outcome, or the recipe reporter's options). */
  objectArg: 0 | 1
  /** The event when the object names no `type`. Null: the object must name it. */
  defaultType: string | null
  /** What the reporter fills in by itself. */
  builtIn: ReadonlySet<"value" | "currency" | "adMatch" | "eventId" | "path">
  /** Only these keys of the object are sent (the rest are inputs the reporter hashes); null = the whole object. */
  sentKeys: ReadonlySet<string> | null
}

const GENERIC_REPORTER: OutcomeReporter = { objectArg: 0, defaultType: null, builtIn: new Set(), sentKeys: null }

export const OUTCOME_REPORTERS: Readonly<Record<string, OutcomeReporter>> = {
  reportInfiniteOutcome: GENERIC_REPORTER,
  reportInfiniteOutcomeInBackground: GENERIC_REPORTER,
  reportInfiniteOutcomeForMirror: GENERIC_REPORTER,
  postInfiniteOutcome: GENERIC_REPORTER,
  reportStripeCheckoutPurchase: { objectArg: 1, defaultType: "purchase", builtIn: new Set(["value", "currency", "adMatch", "eventId"]), sentKeys: new Set(["path", "type"]) },
  reportStripeCheckoutStarted: { objectArg: 1, defaultType: "begin_checkout", builtIn: new Set(["value", "currency", "adMatch", "eventId"]), sentKeys: new Set(["path", "type"]) },
  reportInfiniteLead: { objectArg: 1, defaultType: "lead", builtIn: new Set(["adMatch", "eventId", "path"]), sentKeys: new Set(["path", "type", "properties"]) }
}

/** The reporter names, for `callsOf`. */
export const OUTCOME_CALL_NAMES: readonly string[] = Object.keys(OUTCOME_REPORTERS)

export interface OutcomeCall {
  file: string
  call: Call
  reporter: OutcomeReporter
  /** The outcome's `type` as written (or the reporter's default), or null when it is computed. */
  type: string | null
  event: InventoryEvent | null
  /** The object's top-level properties, or null when the wizard cannot read it as an object. */
  props: Map<string, string> | null
}

/** The object argument at `index` of a call, as top-level properties (null: not an object literal). */
function objectArgProps(call: Call, index: 0 | 1): Map<string, string> | null {
  if (index === 0) return topLevelProps(call)
  const parts = splitTopLevelArgs(call.args)
  const part = parts[1]
  if (part === undefined) return new Map()
  const masked = maskCommentsAndStrings(part, true)
  const start = masked.indexOf("{")
  if (start < 0 || masked.slice(0, start).trim() !== "") return null
  return objectProps(part, masked, start)
}

export function outcomesIn(file: string, text: string): OutcomeCall[] {
  return callsOf(text, OUTCOME_CALL_NAMES).map((call) => {
    const reporter = OUTCOME_REPORTERS[call.name] ?? GENERIC_REPORTER
    const props = objectArgProps(call, reporter.objectArg)
    const raw = props?.get("type") ?? props?.get("eventName")
    const type = raw === undefined ? (props === null ? null : reporter.defaultType) : literalString(raw)
    return { file, call, reporter, type, event: type === null ? null : canonicalEvent(type), props }
  })
}

/** An outcome's object carries `key`, or its reporter fills it in by itself. */
export function outcomeHas(outcome: Pick<OutcomeCall, "reporter" | "props">, key: "value" | "currency" | "adMatch" | "eventId" | "path"): boolean {
  return outcome.reporter.builtIn.has(key as never) || (outcome.props?.has(key) ?? false)
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

export const COMMERCE_RULES = [
  "promise_missing",
  "outcome_without_ad_match",
  "tracking_signal_not_carried",
  "purchase_without_value",
  "double_count",
  "sent_twice_on_one_click",
  "lost_before_leaving",
  "code_after_return",
  "lead_may_send_nothing",
  "page_built_meta_event_id",
  "pii_in_outcome",
  "pii_in_stripe_metadata"
] as const
export type CommerceRule = (typeof COMMERCE_RULES)[number]

export interface CommerceFinding {
  rule: CommerceRule
  state: "problem" | "undetermined"
  message: string
  file?: string
  line?: number
  event?: InventoryEvent
  tool?: InventoryTool
}

export interface CommerceCheckInput {
  /** The code now (repo-relative path → text). */
  files: ReadonlyMap<string, string>
  /**
   * The same files before the run: text, null = the file did not exist. Undefined (or a file missing from the map) =
   * the base could not be read, so what the turn ADDED cannot be told apart from the site's own code.
   */
  base?: ReadonlyMap<string, string | null>
  /** The scan's event × tool inventory (what the site sends, what the plan promised). */
  inventory?: EventInventory | null
  /**
   * Meta gets this site's conversions (connected in Infinite, or the site runs a pixel). False only when Meta is
   * known to be absent; undetermined (undefined) counts as Meta, the founder's rule being "every conversion to Meta".
   */
  metaInUse?: boolean
}

const CODE_FILE = /\.(?:[cm]?[jt]sx?|astro|vue|svelte)$/i
/** Infinite's own generated modules: they hold no site event, only the helpers. */
const MANAGED_FILE = /(?:^|\/)lib\/infinite-[\w-]+\.[cm]?[jt]sx?$/

function codeFiles(files: ReadonlyMap<string, string>): Array<[string, string]> {
  return [...files].filter(([file]) => CODE_FILE.test(file) && !MANAGED_FILE.test(file))
}

const where = (file: string, line: number) => `${file}:${line}`
const listWhere = (evidence: ReadonlyArray<{ file: string; line: number }>) =>
  evidence.slice(0, 2).map((entry) => where(entry.file, entry.line)).join(", ") + (evidence.length > 2 ? ", …" : "")

/** The Meta events that reach Meta from the server (through Infinite), never from the page. */
const META_SERVER_EVENTS: ReadonlySet<InventoryEvent> = new Set<InventoryEvent>(["begin_checkout", "purchase", "lead", "sign_up", "start_trial"])

/** What each promise needs in the code, and whether it is there. */
export function promiseFindings(input: CommerceCheckInput, only?: InventoryEvent | null): CommerceFinding[] | null {
  if (!input.inventory) return null
  const files = codeFiles(input.files)
  const sends = files.flatMap(([file, text]) => sendsIn(file, text))
  const outcomes = files.filter(([file, text]) => isServerFile(file, text)).flatMap(([file, text]) => outcomesIn(file, text))
  const findings: CommerceFinding[] = []
  for (const promise of promisesOf(input.inventory)) {
    if (only && promise.event !== only) continue
    const { event, tool, lane } = promise
    const row = input.inventory.rows.find((entry) => entry.event === event)
    const sites = row?.sites ?? []
    const at = sites.length > 0 ? ` (the site's ${event} is at ${listWhere(sites)})` : ""
    if (lane === "server" || (tool === "meta" && META_SERVER_EVENTS.has(event))) {
      if (outcomes.some((outcome) => outcome.event === event)) continue
      findings.push({
        rule: "promise_missing",
        state: "problem",
        event,
        tool,
        message: `The plan promised ${TOOL_WORDS[tool]} the ${event} from the server${tool === "meta" ? ` (Meta ${META_EVENT_NAMES[event]})` : ""}, but no server code reports it: there is no reportInfiniteOutcome({ type: "${event}", … }) call${at}.`
      })
      continue
    }
    if (sends.some((send) => send.tool === tool && send.event === event)) continue
    findings.push({
      rule: "promise_missing",
      state: "problem",
      event,
      tool,
      message:
        tool === "meta"
          ? `The plan promised Meta ${META_EVENT_NAMES[event]}, but no code sends it: Meta still gets no ${META_EVENT_NAMES[event]}${at}.`
          : `The plan promised ${TOOL_WORDS[tool]} the ${event} event, but no code sends it to ${TOOL_WORDS[tool]}${at}.`
    })
  }
  return findings
}

/** An outcome for an event Meta gets from the server must carry the match data (`adMatch`). */
export function adMatchFindings(input: CommerceCheckInput): CommerceFinding[] {
  if (input.metaInUse === false) return []
  const findings: CommerceFinding[] = []
  for (const [file, text] of codeFiles(input.files)) {
    for (const outcome of outcomesIn(file, text)) {
      if (outcome.event === null || !(META_SERVER_EVENTS.has(outcome.event) || outcome.event === "add_to_cart" || outcome.event === "view_item")) continue
      if (outcome.reporter.builtIn.has("adMatch")) continue
      if (outcome.props === null) {
        findings.push({ rule: "outcome_without_ad_match", state: "undetermined", file, line: outcome.call.line, event: outcome.event, message: `${where(file, outcome.call.line)} passes a value the wizard cannot read, so whether the ${outcome.event} carries match data for Meta is unknown.` })
        continue
      }
      if (outcomeHas(outcome, "adMatch")) continue
      if ([...outcome.props.keys()].some((key) => key.startsWith("..."))) {
        findings.push({ rule: "outcome_without_ad_match", state: "undetermined", file, line: outcome.call.line, event: outcome.event, message: `${where(file, outcome.call.line)} spreads another object into the ${outcome.event}, so whether it carries match data for Meta is unknown.` })
        continue
      }
      findings.push({
        rule: "outcome_without_ad_match",
        state: "problem",
        file,
        line: outcome.call.line,
        event: outcome.event,
        message: `${where(file, outcome.call.line)} reports the ${outcome.event} to Infinite without match data (no adMatch), so Meta cannot tie it to an ad click.`
      })
    }
  }
  return findings
}

// ---- the page's tracking signal (Finding 1) ----

/** Where a request carries the signal: in its body (a posted form's field, a JSON key) or in its URL. */
type SignalPlace = "body" | "query"
interface SignalUse {
  key: "ad_match" | "adMatch"
  place: SignalPlace | "unknown"
  index: number
  line: number
}

/** The trigger sites of a server route (never where a page sends from). */
const SERVER_ROUTE_VIAS: ReadonlySet<string> = new Set(["stripe.checkout.sessions.create", "form-api", "payment-webhook", "reportInfiniteOutcome"])
/** The conversions whose route reads the page's signal (a purchase reads what the checkout saved on the session). */
const SIGNAL_EVENTS: ReadonlySet<InventoryEvent> = new Set<InventoryEvent>(["begin_checkout", "lead", "sign_up", "start_trial"])

/** The innermost `<form …>` still open before `index`: its method, lower case (HTML's default is GET), or null. */
function formMethodBefore(text: string, index: number): string | null {
  const opens = [...text.slice(0, index).matchAll(/<form\b/g)]
  for (let at = opens.length - 1; at >= 0; at -= 1) {
    const start = opens[at]!.index ?? 0
    if (/<\/form\s*>/.test(text.slice(start, index))) continue
    const tag = text.slice(start, Math.min(index, start + 600))
    return /\bmethod\s*=\s*\{?\s*(['"`])(\w+)\1/i.exec(tag)?.[2]?.toLowerCase() ?? "get"
  }
  return null
}

/** What a page SENDS as the signal: a form field, a JSON key, a URL parameter (`name="ad_match"`, `adMatch: …`, `?ad_match=1`). */
export function signalSends(text: string): SignalUse[] {
  const strings = maskCommentsAndStrings(text, false)
  const code = maskCommentsAndStrings(text, true)
  const out: SignalUse[] = []
  for (const match of strings.matchAll(/\b(ad_match|adMatch)\b/g)) {
    const index = match.index ?? 0
    const key = match[1] as SignalUse["key"]
    const inString = code.slice(index, index + key.length) !== key
    const before = strings.slice(Math.max(0, index - 40), index)
    const after = strings.slice(index + key.length, index + key.length + 12)
    let place: SignalUse["place"] | null = null
    if (inString) {
      if (/\bname\s*=\s*\{?\s*["'`]$/.test(before)) {
        const method = formMethodBefore(strings, index)
        place = method === null ? "unknown" : method === "post" ? "body" : "query"
      } else if (/^\s*=/.test(after)) place = "query"
      else if (/\.\s*(?:append|set)\s*\(\s*["'`]$/.test(before)) place = "body"
      else if (/^["'`]\s*:/.test(after)) place = "body"
    } else {
      // A read (`x.adMatch`) is not a send; an object key (`adMatch: …`) or a shorthand property (`{ adMatch }`) is.
      if (/(?:\.|\?\.)\s*$/.test(before)) continue
      if (/^\s*:/.test(after) && !/\?\s*$/.test(before)) place = "body"
      else if (/[{,]\s*$/.test(before) && /^\s*[,}]/.test(after)) place = "body"
    }
    if (place !== null) out.push({ key, place, index, line: lineNumberAt(text, index) })
  }
  return out
}

/** Where a route READS the signal: `req.body?.ad_match`, `req.query.ad_match`, `searchParams.get("ad_match")`, `form.get(…)`. */
export function signalReads(text: string): SignalUse[] {
  const strings = maskCommentsAndStrings(text, false)
  const out: SignalUse[] = []
  const placeOf = (chain: string): SignalUse["place"] => {
    const query = Math.max(chain.lastIndexOf("query"), chain.lastIndexOf("searchParams"))
    const body = Math.max(chain.lastIndexOf("body"), chain.lastIndexOf("form"), chain.lastIndexOf("Form"))
    return query < 0 && body < 0 ? "unknown" : query > body ? "query" : "body"
  }
  const lineStart = (index: number) => strings.lastIndexOf("\n", index) + 1
  const patterns: RegExp[] = [/(?:\.|\?\.)\s*(ad_match|adMatch)\b/g, /\[\s*["'`](ad_match|adMatch)["'`]\s*\]/g, /\.\s*get\s*\(\s*["'`](ad_match|adMatch)["'`]\s*\)/g]
  for (const pattern of patterns) {
    for (const match of strings.matchAll(pattern)) {
      const index = match.index ?? 0
      out.push({ key: match[1] as SignalUse["key"], place: placeOf(strings.slice(lineStart(index), index)), index, line: lineNumberAt(text, index) })
    }
  }
  // Destructured: `const { ad_match } = req.query`.
  for (const match of strings.matchAll(/\{([^{}]*)\}\s*=\s*([^;\n]+)/g)) {
    const key = /\b(ad_match|adMatch)\b/.exec(match[1]!)?.[1] as SignalUse["key"] | undefined
    if (!key) continue
    const index = match.index ?? 0
    out.push({ key, place: placeOf(match[2]!), index, line: lineNumberAt(text, index) })
  }
  return out
}

const PLACE_WORDS: Readonly<Record<SignalPlace, string>> = { body: "the request body", query: "the URL" }
const SIGNAL_CARRY: Readonly<Record<"form" | "json" | "query" | "unknown", string>> = {
  form: 'a hidden field inside its form (<input type="hidden" name="ad_match" value={<the signal> ? "1" : "0"} />), read in the route as req.body.ad_match === "1"',
  json: "adMatch: <the signal> in its JSON body, read in the route as req.body.adMatch === true",
  query: 'ad_match=1 in its URL only when the signal is true, read in the route as req.query.ad_match === "1"',
  unknown: "the signal where the request already carries data (a posted form's hidden ad_match field, adMatch in a JSON body, or ad_match=1 in the URL), read in the route from that same place"
}

/**
 * Finding 1: the page that sends a server conversion's request carries the visitor's tracking signal, BUILT FROM the
 * site's signal (its own consent reader, the tag's helper, or `true` with no gate), under the key and in the place the
 * route reads it. A page that sends nothing, a signal the route reads from elsewhere (`req.query` for a posted form) or
 * under another key, leaves `trackingAllowed` false: InitiateCheckout and Lead then reach Meta with no match data.
 * Read only once the route reads a signal or reports the conversion (the job did its work there).
 */
export function signalFindings(input: CommerceCheckInput): CommerceFinding[] {
  const inventory = input.inventory
  if (!inventory || input.metaInUse === false) return []
  const signal = inventory.trackingSignal
  const reader = signal?.kind === "site_getter" ? signal.name : signal?.kind === "tag_helper" ? "infiniteAdMatchAllowed" : null
  const findings: CommerceFinding[] = []
  const seen = new Set<string>()
  for (const row of inventory.rows) {
    if (!SIGNAL_EVENTS.has(row.event)) continue
    const routes = [...new Set((row.sites ?? []).filter((site) => site.via === "stripe.checkout.sessions.create" || site.via === "form-api").map((site) => site.file))]
    for (const route of routes) {
      const routeText = input.files.get(route)
      if (routeText === undefined) continue
      const reads = signalReads(routeText)
      if (reads.length === 0 && !/\btrackingAllowed\b/.test(maskCommentsAndStrings(routeText, true)) && outcomesIn(route, routeText).length === 0) continue
      const requests = (inventory.pageRequests ?? []).filter((request) => request.route === route)
      const pages = requests.length > 0
        ? requests.map((request) => ({ file: request.file, line: request.line, how: request.how }))
        : (row.sites ?? []).filter((site) => !SERVER_ROUTE_VIAS.has(site.via ?? "")).map((site) => ({ file: site.file, line: site.line, how: "unknown" as const }))
      for (const page of pages) {
        const key = `${route}\u0000${page.file}`
        if (seen.has(key)) continue
        seen.add(key)
        const pageText = input.files.get(page.file)
        if (pageText === undefined) continue
        const sends = signalSends(pageText)
        const at = where(page.file, page.line)
        if (sends.length === 0) {
          findings.push({ rule: "tracking_signal_not_carried", state: "problem", file: page.file, line: page.line, event: row.event, message: `${at} sends its request to ${route} with no tracking signal, so the ${row.event} reaches Meta with no match data. Add ${SIGNAL_CARRY[page.how]}.` })
          continue
        }
        if (reader) {
          const built = sends.some((send) => new RegExp(`\\b${reader}\\s*\\(`).test(maskCommentsAndStrings(pageText, false).slice(Math.max(0, send.index - 200), send.index + 200)))
          if (!built) {
            findings.push({ rule: "tracking_signal_not_carried", state: "problem", file: page.file, line: sends[0]!.line, event: row.event, message: `${where(page.file, sends[0]!.line)} sends ${sends[0]!.key}, but not from the site's tracking signal (${signal?.kind === "site_getter" ? signal.expression : "infiniteAdMatchAllowed()"}), so match data could reach Meta for a visitor who did not allow tracking, or never reach it.` })
            continue
          }
        }
        if (reads.length === 0) {
          findings.push({ rule: "tracking_signal_not_carried", state: "problem", file: route, line: 1, event: row.event, message: `${route} never reads the tracking signal ${at} sends (${sends[0]!.key} in ${sends[0]!.place === "query" ? "the URL" : "the request body"}), so trackingAllowed stays false and the ${row.event} reaches Meta with no match data.` })
          continue
        }
        const match = sends.some((send) => reads.some((read) => read.key === send.key && (read.place === send.place || read.place === "unknown" || send.place === "unknown")))
        if (match) continue
        const send = sends[0]!
        const read = reads[0]!
        findings.push({
          rule: "tracking_signal_not_carried",
          state: "problem",
          file: route,
          line: read.line,
          event: row.event,
          message: `${where(page.file, send.line)} sends the tracking signal as ${send.key} in ${send.place === "unknown" ? "its request" : PLACE_WORDS[send.place]}, but ${where(route, read.line)} reads ${read.key} from ${read.place === "unknown" ? "somewhere else" : PLACE_WORDS[read.place]}, so trackingAllowed is always false and the ${row.event} reaches Meta with no match data. Read the same key from the same place the page sends it.`
        })
      }
    }
  }
  return findings
}

/** `value` / `currency` at the top level or inside a literal `properties: { … }`: present, absent, or unreadable. */
function moneyField(props: Map<string, string>, key: "value" | "currency"): "present" | "absent" | "unknown" {
  if (props.has(key)) return "present"
  const properties = props.get("properties")
  if (properties === undefined) return [...props.keys()].some((entry) => entry.startsWith("...")) ? "unknown" : "absent"
  const masked = maskCommentsAndStrings(properties, true)
  const open = masked.indexOf("{")
  if (open !== 0) return "unknown"
  const inner = objectProps(properties, masked, 0)
  if (inner.has(key)) return "present"
  return [...inner.keys()].some((entry) => entry.startsWith("...")) ? "unknown" : "absent"
}

/** A purchase outcome carries its value and its currency (Meta's Purchase needs both; Infinite's revenue too). */
export function valueFindings(input: CommerceCheckInput): CommerceFinding[] {
  const findings: CommerceFinding[] = []
  for (const [file, text] of codeFiles(input.files)) {
    for (const outcome of outcomesIn(file, text)) {
      if (outcome.event !== "purchase") continue
      const line = outcome.call.line
      if (outcome.reporter.builtIn.has("value") && outcome.reporter.builtIn.has("currency")) continue
      if (outcome.props === null) {
        findings.push({ rule: "purchase_without_value", state: "undetermined", file, line, event: "purchase", message: `${where(file, line)} passes a value the wizard cannot read, so whether the purchase carries its value and currency is unknown.` })
        continue
      }
      const value = outcome.reporter.builtIn.has("value") ? "present" : moneyField(outcome.props, "value")
      const currency = outcome.reporter.builtIn.has("currency") ? "present" : moneyField(outcome.props, "currency")
      const missing = [value === "absent" ? "value" : null, currency === "absent" ? "currency" : null].filter((entry): entry is string => entry !== null)
      if (missing.length > 0) {
        findings.push({
          rule: "purchase_without_value",
          state: "problem",
          file,
          line,
          event: "purchase",
          message: `${where(file, line)} reports a purchase without its ${missing.join(" or ")}, so Meta and Infinite record a sale with no amount.`
        })
      } else if (value === "unknown" || currency === "unknown") {
        findings.push({ rule: "purchase_without_value", state: "undetermined", file, line, event: "purchase", message: `${where(file, line)} builds the purchase's properties elsewhere, so whether it carries its value and currency is unknown.` })
      }
    }
  }
  return findings
}

type SendKey = `${InventoryTool}:${InventoryEvent}`
const keyOf = (send: Pick<Send, "tool" | "event">): SendKey => `${send.tool}:${send.event}`

/** A send this run added to a tool that already gets that event from the site counts every such event twice. */
export function doubleCountFindings(input: CommerceCheckInput): CommerceFinding[] | null {
  if (!input.base) return null
  const files = codeFiles(input.files)
  const already = new Map<SendKey, Array<{ file: string; line: number }>>()
  const remember = (key: SendKey, evidence: ReadonlyArray<{ file: string; line: number }>) => already.set(key, [...(already.get(key) ?? []), ...evidence])
  for (const entry of input.inventory ? alreadySentOf(input.inventory) : []) remember(keyOf(entry), entry.evidence)
  const baseCount = new Map<SendKey, number>()
  const nowCount = new Map<SendKey, number>()
  const added: Send[] = []
  const keptSends: Send[] = []
  for (const [file, text] of files) {
    if (!input.base.has(file)) return null
    const before = input.base.get(file) ?? null
    const beforeSends = before === null ? [] : sendsIn(file, before)
    const beforeLines = new Set((before ?? "").split("\n").map((line) => line.trim()))
    for (const send of beforeSends) {
      baseCount.set(keyOf(send), (baseCount.get(keyOf(send)) ?? 0) + 1)
      remember(keyOf(send), [{ file: send.file, line: send.line }])
    }
    const lines = text.split("\n")
    for (const send of sendsIn(file, text)) {
      nowCount.set(keyOf(send), (nowCount.get(keyOf(send)) ?? 0) + 1)
      if (beforeLines.has((lines[send.line - 1] ?? "").trim())) keptSends.push(send)
      else added.push(send)
    }
  }
  // A base file the run deleted still held the site's own sends.
  for (const [file, before] of input.base) {
    if (before === null || input.files.has(file) || !CODE_FILE.test(file)) continue
    for (const send of sendsIn(file, before)) {
      baseCount.set(keyOf(send), (baseCount.get(keyOf(send)) ?? 0) + 1)
      remember(keyOf(send), [{ file: send.file, line: send.line }])
    }
  }
  const findings: CommerceFinding[] = []
  const reported = new Set<SendKey>()
  for (const send of added) {
    const key = keyOf(send)
    if (reported.has(key) || send.tool === "infinite") continue
    if ((already.get(key) ?? []).length === 0) continue
    // Where the site's own send is NOW (its line kept from before the run); else where the scan found it.
    const kept = keptSends.filter((entry) => keyOf(entry) === key)
    const earlier = kept.length > 0 ? kept : already.get(key)!
    // Moving the site's own send (one removed, one added) is not a second send.
    if ((nowCount.get(key) ?? 0) <= (baseCount.get(key) ?? 0) && (baseCount.get(key) ?? 0) > 0) continue
    reported.add(key)
    const tool = TOOL_WORDS[send.tool]
    findings.push({
      rule: "double_count",
      state: "problem",
      file: send.file,
      line: send.line,
      event: send.event,
      tool: send.tool,
      message: `${where(send.file, send.line)} sends ${tool} the ${send.event} (${send.via}), but the site already sends ${tool} the ${send.event} (${listWhere(earlier)}), so every ${send.event} would count twice in ${tool}.${send.via.startsWith("infiniteTrack") ? ` Turn ${tool} off for this call (destinations: { ${send.tool}: false }).` : ""}`
    })
  }
  return findings
}

// ---- one click path (P1-A) ----

/** A function's body in a file: `name` when it is bound to one, its body's offsets, and its parameters' offsets. */
interface FunctionRange {
  name: string | null
  start: number
  end: number
}

/** The index of the bracket that opens the one closing at `close` (masked text), or -1. */
function openingOf(masked: string, close: number): number {
  let depth = 0
  for (let cursor = close; cursor >= 0; cursor -= 1) {
    const ch = masked[cursor]
    if (ch === ")" || ch === "}" || ch === "]") depth += 1
    else if (ch === "(" || ch === "{" || ch === "[") {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  return -1
}

/** Every function body (declarations, function expressions and arrows) in masked text, with the name it is bound to. */
export function functionRanges(masked: string): FunctionRange[] {
  const out: FunctionRange[] = []
  const bodyFrom = (from: number): { start: number; end: number } | null => {
    let at = from
    while (at < masked.length && /\s/.test(masked[at]!)) at += 1
    if (masked[at] === "{") {
      const end = closingOf(masked, at)
      return end < 0 ? null : { start: at + 1, end }
    }
    // An expression body: to the end of the expression (a `,`, `;` or closing bracket at depth 0).
    let depth = 0
    for (let cursor = at; cursor < masked.length; cursor += 1) {
      const ch = masked[cursor]!
      if (ch === "(" || ch === "{" || ch === "[") depth += 1
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) return { start: at, end: cursor }
        depth -= 1
      } else if ((ch === "," || ch === ";") && depth === 0) return { start: at, end: cursor }
      else if (ch === "\n" && depth === 0 && cursor > at) {
        // A line break ends the expression unless the statement plainly goes on (`a\n  .then(…)`, `a &&\n b`).
        const before = masked.slice(at, cursor).trimEnd().slice(-1)
        const after = masked.slice(cursor).trimStart()[0] ?? ""
        if (!/[([{,=+\-*/%&|?:.<>!]/.test(before) && !/[.?:+\-*/%&|=]/.test(after)) return { start: at, end: cursor }
      }
    }
    return { start: at, end: masked.length }
  }
  const boundName = (before: number): string | null =>
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?(?:function\b[^(]*)?$/.exec(masked.slice(Math.max(0, before - 160), before))?.[1] ??
    /(?:^|[\s,{;])([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?$/.exec(masked.slice(Math.max(0, before - 80), before))?.[1] ??
    null
  for (const match of masked.matchAll(/\bfunction\b\s*\*?\s*([A-Za-z_$][\w$]*)?\s*(?:<[^>()]*>)?\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = closingOf(masked, open)
    if (close < 0) continue
    const brace = /^\s*(?::[^{;=]*)?\{/.exec(masked.slice(close + 1, close + 200))
    if (!brace) continue
    const start = close + brace[0].length
    const end = closingOf(masked, start)
    if (end < 0) continue
    out.push({ name: match[1] ?? boundName(match.index ?? 0), start: start + 1, end })
  }
  for (const match of masked.matchAll(/=>/g)) {
    const arrow = match.index ?? 0
    let head = arrow - 1
    while (head >= 0 && /\s/.test(masked[head]!)) head -= 1
    // Skip a return type annotation: `(a): void =>` is read from its parameter list.
    let paramsStart: number
    if (masked[head] === ")") paramsStart = openingOf(masked, head)
    else {
      const ident = /[A-Za-z_$][\w$]*$/.exec(masked.slice(Math.max(0, head - 60), head + 1))
      if (!ident) continue
      paramsStart = head + 1 - ident[0].length
    }
    if (paramsStart < 0) continue
    const body = bodyFrom(arrow + 2)
    if (!body) continue
    const before = masked.slice(Math.max(0, paramsStart - 10), paramsStart)
    const asyncStart = /async\s*$/.test(before) ? paramsStart - (before.length - before.search(/async\s*$/)) : paramsStart
    out.push({ name: boundName(asyncStart), start: body.start, end: body.end })
  }
  return out
}

/** The innermost function holding `index`, or null (module level). */
function innermost(ranges: readonly FunctionRange[], index: number): FunctionRange | null {
  let best: FunctionRange | null = null
  for (const range of ranges) if (range.start <= index && index < range.end && (!best || range.start >= best.start)) best = range
  return best
}

/** A component or a hook (`Page`, `useCart`), or a function that returns markup: it holds handlers, it is not one. */
function holdsHandlers(masked: string, range: FunctionRange): boolean {
  if (range.name && (/^[A-Z]/.test(range.name) || /^use[A-Z]/.test(range.name))) return true
  const body = masked.slice(range.start, range.end)
  return masked[range.start - 1] === "{" ? /\breturn\s*\(?\s*<[A-Za-z>]/.test(body) : /^\s*\(?\s*<[A-Za-z>]/.test(body)
}

/**
 * Finding 2: the click handler holding `index`: the OUTERMOST function that is not a component, a hook or a render
 * function. A nested arrow inside a handler (`infiniteLeaveAfter(() => …)`) is part of the same click.
 */
function outermostHandler(masked: string, ranges: readonly FunctionRange[], index: number): FunctionRange | null {
  const holding = ranges.filter((range) => range.start <= index && index < range.end).sort((a, b) => a.start - b.start || b.end - a.end)
  return holding.find((range) => !holdsHandlers(masked, range)) ?? null
}

/** The innermost NAMED function holding `index` (the helper a send is in), or null. */
function innermostNamed(ranges: readonly FunctionRange[], index: number): FunctionRange | null {
  let best: FunctionRange | null = null
  for (const range of ranges) if (range.name && range.start <= index && index < range.end && (!best || range.start >= best.start)) best = range
  return best
}

interface ClickPathFile {
  file: string
  text: string
  masked: string
  ranges: FunctionRange[]
}

/** One reach of a browser event on a click path: a send itself, or a call of a helper that sends it. */
interface Reach {
  tool: InventoryTool
  event: InventoryEvent
  file: string
  line: number
  index: number
  /** The helper called, or null for a send written here. */
  through: string | null
  /** Where the helper's own send is. */
  sendAt: { file: string; line: number }
  /** For a send written here: what sends it (`infiniteTrackThenNavigate`, `fbq`, …). */
  via?: string
}

const BROWSER_STEP_EVENTS: ReadonlySet<InventoryEvent> = new Set<InventoryEvent>(["view_item", "add_to_cart"])

/** Every reach of a browser Meta / GA4 / PostHog commerce send, sends first, then the helpers that hold them (3 levels). */
function clickPathReaches(files: readonly ClickPathFile[]): Reach[] {
  const reaches: Reach[] = []
  const helpers = new Map<string, Reach[]>() // helper name → what calling it reaches
  for (const entry of files) {
    for (const send of sendsIn(entry.file, entry.text)) {
      if (send.index === undefined || send.tool === "infinite" || !BROWSER_STEP_EVENTS.has(send.event)) continue
      const reach: Reach = { tool: send.tool, event: send.event, file: entry.file, line: send.line, index: send.index, through: null, sendAt: { file: entry.file, line: send.line }, via: send.via }
      reaches.push(reach)
      const holder = innermostNamed(entry.ranges, send.index)
      if (holder?.name) helpers.set(holder.name, [...(helpers.get(holder.name) ?? []), reach])
    }
  }
  const seen = new Set<string>()
  for (let round = 0; round < 3; round += 1) {
    let grew = false
    for (const [helper, held] of [...helpers]) {
      const pattern = new RegExp(`(?<![\\w$.])${helper.replace(/\$/g, "\\$")}\\s*\\(`, "g")
      for (const entry of files) {
        for (const match of entry.masked.matchAll(pattern)) {
          const index = match.index ?? 0
          // The declaration itself is not a call.
          if (/\bfunction\s*\*?\s*$/.test(entry.masked.slice(Math.max(0, index - 20), index))) continue
          const close = closingOf(entry.masked, index + match[0].length - 1)
          if (close > 0 && /^\s*(?::[^{;=]*)?\{/.test(entry.masked.slice(close + 1, close + 100)) && !/[=(,:?]\s*$/.test(entry.masked.slice(Math.max(0, index - 10), index))) continue
          for (const inner of held) {
            const key = `${entry.file}\u0000${index}\u0000${inner.tool}\u0000${inner.event}\u0000${helper}`
            if (seen.has(key)) continue
            seen.add(key)
            const reach: Reach = { tool: inner.tool, event: inner.event, file: entry.file, line: lineNumberAt(entry.text, index), index, through: helper, sendAt: inner.sendAt }
            reaches.push(reach)
            const holder = innermostNamed(entry.ranges, index)
            if (holder?.name && holder.name !== helper) {
              helpers.set(holder.name, [...(helpers.get(holder.name) ?? []), reach])
              grew = true
            }
          }
        }
      }
    }
    if (!grew) break
  }
  return reaches
}

function clickPathFiles(input: CommerceCheckInput): ClickPathFile[] {
  return codeFiles(input.files)
    .filter(([file, text]) => !isServerFile(file, text))
    .map(([file, text]) => {
      const masked = maskCommentsAndStrings(text, true)
      return { file, text, masked, ranges: functionRanges(masked) }
    })
}

/**
 * P1-A: one click reaches two sends of the same browser event to one tool: the agent put the send inside the site's
 * helper AND in the handler that calls it (or the handler calls two helpers that both send it). Every such click counts
 * the event twice in that tool.
 */
export function clickPathFindings(input: CommerceCheckInput): CommerceFinding[] {
  const files = clickPathFiles(input)
  const reaches = clickPathReaches(files)
  const findings: CommerceFinding[] = []
  const reported = new Set<string>()
  for (const entry of files) {
    const here = reaches.filter((reach) => reach.file === entry.file)
    const groups = new Map<string, Reach[]>()
    for (const reach of here) {
      const fn = outermostHandler(entry.masked, entry.ranges, reach.index)
      if (!fn) continue
      const key = `${fn.start}\u0000${reach.tool}\u0000${reach.event}`
      groups.set(key, [...(groups.get(key) ?? []), reach])
    }
    for (const group of groups.values()) {
      // Two reaches of distinct sends (the same helper called twice in one handler is the site's own choice).
      const distinct = [...new Map(group.map((reach) => [`${reach.sendAt.file}:${reach.sendAt.line}`, reach])).values()]
      if (distinct.length < 2) continue
      const [first, second] = distinct as [Reach, Reach]
      const key = `${entry.file}:${first.line}:${first.tool}:${first.event}`
      if (reported.has(key)) continue
      reported.add(key)
      const word = (reach: Reach) => (reach.through ? `through ${reach.through}() (its send at ${where(reach.sendAt.file, reach.sendAt.line)})` : `itself at ${where(reach.file, reach.line)}`)
      const tool = TOOL_WORDS[first.tool]
      const name = first.tool === "meta" ? META_EVENT_NAMES[first.event] : first.event
      findings.push({
        rule: "sent_twice_on_one_click",
        state: "problem",
        file: entry.file,
        line: Math.min(first.line, second.line),
        event: first.event,
        tool: first.tool,
        message: `One click at ${where(entry.file, Math.min(first.line, second.line))} sends ${tool} ${name} twice: ${word(first)} and ${word(second)}, so every click counts twice in ${tool}. Keep only the send inside the site's helper.`
      })
    }
  }
  return findings
}

/** A navigation, in code: a full page load, client routing, a form submit, a new window. */
const NAVIGATION = /\blocation\b\s*(?:\.\s*(?:assign|replace)\s*\(|(?:\.\s*href\s*)?=(?![=>]))|\b(?:router|Router|history)\s*\.\s*(?:push|replace)\s*\(|\bnavigate\s*\(|\.\s*(?:requestSubmit|submit)\s*\(\s*\)|\bwindow\s*\.\s*open\s*\(/

/** `go` really leaves: a navigation, a call, or a function passed by name; never `() => {}` / `() => undefined`. */
function leaves(go: string): boolean {
  const text = go.trim()
  if (text === "" || /^(?:undefined|null|void\s+0)$/.test(text)) return false
  if (/^(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*(?::[^=]+)?=>\s*(?:\{\s*\}|undefined|null|void\s+0|\(\s*\))\s*$/.test(text)) return false
  return NAVIGATION.test(text) || /[\w$\])]\s*\(/.test(text) || /^[\w$.]+$/.test(text)
}

/** Every `infiniteLeaveAfter(start, go)` call: the offsets of its two arguments. */
function leaveAfterCalls(masked: string): Array<{ start: [number, number]; go: [number, number] | null }> {
  const out: Array<{ start: [number, number]; go: [number, number] | null }> = []
  for (const match of masked.matchAll(/\binfiniteLeaveAfter\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    const close = closingOf(masked, open)
    if (close < 0) continue
    let depth = 0
    let comma = -1
    for (let cursor = open + 1; cursor < close; cursor += 1) {
      const ch = masked[cursor]!
      if (ch === "(" || ch === "{" || ch === "[") depth += 1
      else if (ch === ")" || ch === "}" || ch === "]") depth -= 1
      else if (ch === "," && depth === 0) {
        comma = cursor
        break
      }
    }
    out.push(comma < 0 ? { start: [open + 1, close], go: null } : { start: [open + 1, comma], go: [comma + 1, close] })
  }
  return out
}

/** The function body [start, end) returns the call at `index`: `return call(…)`, `() => call(…)`, or `const w = call(…)` … `return w`. */
function returnsCallAt(masked: string, fn: FunctionRange, index: number): boolean {
  const before = masked.slice(fn.start, index)
  if (masked[fn.start - 1] !== "{") return /^[\s(]*(?:await\s+)?$/.test(before)
  if (/\breturn\s+(?:await\s+)?$/.test(before)) return true
  const held = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*(?:await\s+)?$/.exec(before)?.[1]
  return held !== undefined && new RegExp(`\\breturn\\s+(?:await\\s+)?${held.replace(/\$/g, "\\$")}\\b`).test(masked.slice(index, fn.end))
}

/**
 * Finding 2: the send at `reach` is waited for before its click leaves, all the way to the navigation:
 *   • it is `infiniteTrackThenNavigate` itself (it navigates once the request is out);
 *   • it is RETURNED by the `start` of `infiniteLeaveAfter(start, go)` (directly, or through a returned const), and
 *     `go` really navigates;
 *   • its promise's `.then(…)` holds the navigation, or the handler `await`s it and navigates after.
 */
function reachWaits(entry: ClickPathFile, reach: Reach): boolean {
  const { masked, ranges } = entry
  if (reach.through === null && reach.via === "infiniteTrackThenNavigate") return true
  const inner = innermost(ranges, reach.index)
  for (const call of leaveAfterCalls(masked)) {
    if (reach.index < call.start[0] || reach.index >= call.start[1]) continue
    const start = ranges.filter((range) => range.start >= call.start[0] && range.end <= call.start[1]).sort((a, b) => a.start - b.start)[0]
    if (!start || inner !== start) return false
    return returnsCallAt(masked, start, reach.index) && call.go !== null && leaves(masked.slice(call.go[0], call.go[1]))
  }
  const close = closingOf(masked, masked.indexOf("(", reach.index))
  if (close > 0) {
    const then = /^\s*\.\s*then\s*\(/.exec(masked.slice(close + 1, close + 40))
    if (then) {
      const open = close + 1 + then[0].length - 1
      const end = closingOf(masked, open)
      return end > 0 && NAVIGATION.test(masked.slice(open + 1, end))
    }
  }
  if (/\bawait\s*$/.test(masked.slice(Math.max(0, reach.index - 12), reach.index))) {
    const fn = inner
    return close > 0 && NAVIGATION.test(masked.slice(close, fn ? fn.end : masked.length))
  }
  return false
}

/** Finding 4: the click handler holding the reach cancels the element's default action (`event.preventDefault()`). */
function cancelsDefault(entry: ClickPathFile, reach: Reach): boolean {
  const handler = outermostHandler(entry.masked, entry.ranges, reach.index)
  return /\bpreventDefault\s*\(/.test(handler ? entry.masked.slice(handler.start, handler.end) : entry.masked)
}

/** Finding 2: the helper body hands its wait back to the caller: `return infiniteTrackBeforeLeaving(…)` or `return wait`. */
function helperReturnsWait(masked: string, ranges: readonly FunctionRange[], body: FunctionRange): "returned" | "not_returned" | "absent" {
  let found = false
  for (const match of masked.slice(body.start, body.end).matchAll(/\binfiniteTrackBeforeLeaving\s*\(/g)) {
    const index = body.start + (match.index ?? 0)
    if (innermost(ranges, index) !== body) continue
    found = true
    if (returnsCallAt(masked, body, index)) return "returned"
  }
  return found ? "not_returned" : "absent"
}

/**
 * P1-A: the scan saw these clicks leave with a FULL page load (`InventorySite.navigation`); a browser Meta send they
 * reach must be waited for (infiniteLeaveAfter around the handler, infiniteTrackThenNavigate, or the returned wait), or
 * the unload can cancel Meta's request. Read where the handler calls the helper (or sends inline) in its file now.
 */
export function leaveFindings(input: CommerceCheckInput): CommerceFinding[] {
  if (!input.inventory) return []
  const files = clickPathFiles(input)
  const reaches = clickPathReaches(files).filter((reach) => reach.tool === "meta")
  const findings: CommerceFinding[] = []
  for (const row of input.inventory.rows) {
    if (!BROWSER_STEP_EVENTS.has(row.event)) continue
    const leaving = (row.sites ?? []).filter((site) => site.navigation === "full_load")
    for (const file of [...new Set(leaving.map((site) => site.file))]) {
      const entry = files.find((candidate) => candidate.file === file)
      if (!entry) continue
      const helpers = new Set(leaving.filter((site) => site.file === file && site.via?.startsWith("helper:")).map((site) => site.via!.slice("helper:".length)))
      const inline = leaving.some((site) => site.file === file && !site.via?.startsWith("helper:"))
      const here = reaches.filter((reach) => reach.file === file && reach.event === row.event && (reach.through === null ? inline : helpers.has(reach.through)))
      for (const reach of here) {
        // Finding 4: a plain link or a form leaves by itself: the wait only helps once the handler cancels that.
        const byDefault = leaving.some((site) => site.file === file && (site.leavesBy === "link" || site.leavesBy === "form") && (reach.through === null ? !site.via?.startsWith("helper:") : site.via === `helper:${reach.through}`))
        if (reachWaits(entry, reach)) {
          if (!byDefault || cancelsDefault(entry, reach)) continue
          findings.push({
            rule: "lost_before_leaving",
            state: "problem",
            file,
            line: reach.line,
            event: row.event,
            tool: "meta",
            message: `${where(file, reach.line)} waits for Meta ${META_EVENT_NAMES[row.event]}, but its click is on a plain link or a form that leaves by itself, so the page unloads before the wait ends. Call event.preventDefault() first in this handler, and leave through go: () => window.location.assign(<the link's href>) or () => form.submit().`
          })
          break
        }
        findings.push({
          rule: "lost_before_leaving",
          state: "problem",
          file,
          line: reach.line,
          event: row.event,
          tool: "meta",
          message: `${where(file, reach.line)} sends Meta ${META_EVENT_NAMES[row.event]}${reach.through ? ` through ${reach.through}()` : ""} and then leaves with a full page load without waiting, so the page can unload before Meta has it. ${reach.through ? `Start ${reach.through}() with const wait = infiniteTrackBeforeLeaving(…), keep its own sends, end it with return wait, and wrap this handler in infiniteLeaveAfter(() => { …; return ${reach.through}(…) }, () => <its own navigation>).` : "Use infiniteTrackThenNavigate in place of the handler's own navigation."}`
        })
        break
      }
    }
    // The helper a full-load caller waits on must return the wait, not a plain infiniteTrack.
    for (const helper of [...new Set(leaving.filter((site) => site.via?.startsWith("helper:")).map((site) => site.via!.slice("helper:".length)))]) {
      const at = leaving.find((site) => site.via === `helper:${helper}`)?.helperAt
      const entry = at ? files.find((candidate) => candidate.file === at.file) : undefined
      if (!entry) continue
      const body = entry.ranges.find((range) => range.name === helper)
      if (!body) continue
      const metaHere = reaches.some((reach) => reach.file === entry.file && reach.through === null && reach.event === row.event && body.start <= reach.index && reach.index < body.end)
      const wait = helperReturnsWait(entry.masked, entry.ranges, body)
      if (!metaHere || wait === "returned") continue
      if (wait === "not_returned") {
        findings.push({
          rule: "lost_before_leaving",
          state: "problem",
          file: entry.file,
          line: lineNumberAt(entry.text, body.start),
          event: row.event,
          tool: "meta",
          message: `${helper}() starts the wait for Meta ${META_EVENT_NAMES[row.event]} but does not return it, so a caller that leaves with a full page load cannot wait for it. Keep const wait = infiniteTrackBeforeLeaving(…) as its first new line and make return wait its last line.`
        })
        continue
      }
      findings.push({
        rule: "lost_before_leaving",
        state: "problem",
        file: entry.file,
        line: lineNumberAt(entry.text, body.start),
        event: row.event,
        tool: "meta",
        message: `${helper}() sends Meta ${META_EVENT_NAMES[row.event]} with nothing to wait on, but a caller leaves with a full page load right after it. Make the first new line of ${helper}() const wait = infiniteTrackBeforeLeaving(…) and its last line return wait, so that caller can wait.`
      })
    }
  }
  return findings
}

// ---- code after a return (Finding 3) ----

/**
 * The offset where a `return` statement at `at` ends (after its `;`, or at the line break that ends it), or -1 when it
 * runs to the end of the block. Statement continuation over a line break (`return a\n  .then(…)`) is followed.
 */
function returnEnd(masked: string, at: number, end: number): number {
  let depth = 0
  let sawValue = false
  for (let cursor = at + "return".length; cursor < end; cursor += 1) {
    const ch = masked[cursor]!
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return -1
      depth -= 1
    } else if (ch === ";" && depth === 0) return cursor + 1
    else if (ch === "\n" && depth === 0) {
      if (!sawValue) return cursor // `return` alone on its line returns undefined (ASI)
      const before = masked.slice(at, cursor).trimEnd().slice(-1)
      const after = masked.slice(cursor).trimStart()[0] ?? ""
      if (/[([{,=+\-*/%&|?:.<>!]/.test(before) || /[.?:+\-*/%&|,=]/.test(after)) continue
      return cursor
    } else if (!/\s/.test(ch)) sawValue = true
  }
  return -1
}

/** The first statement after a `return` at the top level of the body [start, end), or null (`function` hoists are fine). */
export function codeAfterReturn(masked: string, start: number, end: number): number | null {
  let depth = 0
  for (let cursor = start; cursor < end; cursor += 1) {
    const ch = masked[cursor]!
    if (ch === "(" || ch === "{" || ch === "[") depth += 1
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1
    if (depth !== 0 || ch !== "r" || !/^return\b/.test(masked.slice(cursor, cursor + 7)) || /[\w$.]/.test(masked[cursor - 1] ?? "")) continue
    // The body of an `if (…)` / `else` / loop with no braces is a guard, not the end of the function.
    const before = masked.slice(start, cursor).trimEnd()
    if (/(?:\)|\belse|\bdo)$/.test(before)) continue
    const stop = returnEnd(masked, cursor, end)
    if (stop < 0) return null
    const rest = masked.slice(stop, end)
    const first = rest.search(/\S/)
    if (first < 0 || /^(?:async\s+)?function\b/.test(rest.slice(first))) return null
    return stop + first
  }
  return null
}

/** A body with its whitespace collapsed (a function is "unchanged" when only its layout moved). */
const flat = (text: string) => text.replace(/\s+/g, " ").trim()

/**
 * Finding 3: a function this run changed (or wrote) returns before code that then never runs. The classic: the brief's
 * `return infiniteTrackBeforeLeaving(…)` written as the helper's FIRST line, which silently drops the site's own GA4 and
 * PostHog sends below it while every other check and the compiler pass. Functions the run did not touch are not read.
 */
export function deadCodeFindings(input: Pick<CommerceCheckInput, "files" | "base">): CommerceFinding[] {
  const findings: CommerceFinding[] = []
  for (const [file, text] of codeFiles(input.files)) {
    const before = input.base?.get(file)
    const masked = maskCommentsAndStrings(text, true)
    const baseMasked = typeof before === "string" ? maskCommentsAndStrings(before, true) : null
    const baseBodies = baseMasked === null ? null : new Set(functionRanges(baseMasked).filter((range) => baseMasked[range.start - 1] === "{").map((range) => flat(baseMasked.slice(range.start, range.end))))
    for (const fn of functionRanges(masked)) {
      if (masked[fn.start - 1] !== "{") continue
      if (baseBodies?.has(flat(masked.slice(fn.start, fn.end)))) continue
      const dead = codeAfterReturn(masked, fn.start, fn.end)
      if (dead === null) continue
      const line = lineNumberAt(text, dead)
      const name = fn.name ? `${fn.name}()` : "this function"
      findings.push({
        rule: "code_after_return",
        state: "problem",
        file,
        line,
        message: `${where(file, line)} never runs: ${name} returns before it, so the site's own sends there are lost. Keep every existing line, and put the return as the function's LAST line (const wait = infiniteTrackBeforeLeaving(…) first, return wait last).`
      })
    }
  }
  return findings
}

// ---- leads (P2-7) ----

/** `reportInfiniteLead` with no `fallbackId` sends nothing until the owner sets LEAD_ID_SECRET (no stable id). */
export function leadFindings(input: Pick<CommerceCheckInput, "files">): CommerceFinding[] {
  const findings: CommerceFinding[] = []
  for (const [file, text] of codeFiles(input.files)) {
    for (const outcome of outcomesIn(file, text)) {
      if (outcome.call.name !== "reportInfiniteLead") continue
      const line = outcome.call.line
      if (outcome.props === null || [...outcome.props.keys()].some((key) => key.startsWith("..."))) {
        if (outcome.props?.has("fallbackId")) continue
        findings.push({ rule: "lead_may_send_nothing", state: "undetermined", file, line, event: outcome.event ?? "lead", message: `${where(file, line)} passes options the wizard cannot read, so whether the lead has a fallbackId (needed until LEAD_ID_SECRET is set) is unknown.` })
        continue
      }
      if (outcome.props.has("fallbackId")) continue
      findings.push({
        rule: "lead_may_send_nothing",
        state: "problem",
        file,
        line,
        event: outcome.event ?? "lead",
        message: `${where(file, line)} reports the ${outcome.type ?? "lead"} with no fallbackId, so until LEAD_ID_SECRET is set it has no stable id and sends nothing. Pass fallbackId: the stored sign-up's id, or one new random id per submission.`
      })
    }
  }
  return findings
}

/** A browser Meta event carries only the event id the server got back from Infinite, never one the page made. */
export function metaEventIdFindings(input: CommerceCheckInput): CommerceFinding[] {
  const findings: CommerceFinding[] = []
  for (const [file, text] of codeFiles(input.files)) {
    if (isServerFile(file, text)) continue
    const code = maskCommentsAndStrings(text, false)
    if (!/\bfbq\s*\(/.test(code)) continue
    const before = input.base?.get(file)
    const beforeLines = before ? new Set(before.split("\n").map((line) => line.trim())) : null
    const lines = text.split("\n")
    for (const hit of findEventIdHits(code)) {
      const line = lineNumberAt(text, hit.offset)
      if (beforeLines?.has((lines[line - 1] ?? "").trim())) continue
      findings.push(
        hit.verdict === "built"
          ? { rule: "page_built_meta_event_id", state: "problem", file, line, tool: "meta", message: `${where(file, line)} gives a browser Meta event an event id made in the page; a browser Meta event may only carry the id your server got back from Infinite, or none.` }
          : { rule: "page_built_meta_event_id", state: "undetermined", file, line, tool: "meta", message: `${where(file, line)} gives a browser Meta event an event id the wizard cannot trace to the one your server got back from Infinite.` }
      )
    }
  }
  return findings
}

// ---- personal data ----

const PII_KEYS = /(?<![\w$])(?:email|e_mail|emailAddress|email_address|first_?name|last_?name|full_?name|firstName|lastName|fullName|customer_?name|address|street|line1|postal_?code|zip|postcode)\s*:/i
/** A read of a person's email or phone, or of a buyer's name or address (`customer_details.name`); a product's `.name` is not one. */
const PII_VALUES =
  /\.\s*(?:email|emailAddress|email_address|phone|phoneNumber|phone_number)\b|(?:customer_details|billing_details|shipping_details|shipping|customer|user|buyer|person|profile|subscriber)\s*\??\.\s*(?:name|address|first_?name|last_?name|full_?name|firstName|lastName|fullName)\b|(?<![\w$.])(?:email|phone|phoneNumber|fullName|firstName|lastName)(?![\w$])/
const PHONE = /(?<![\w$])(?:ph|phone|phoneNumber|phone_number|mobile)\s*:|[{,]\s*(?:phone|phoneNumber|phone_number|mobile)\s*(?=[,}])|\.\s*(?:phone|phoneNumber|phone_number)\b/
const HASHED = /\b(?:createHash|sha256|sha-256|hash\w*|digest|\w*Hash(?:ed)?|\w*Digest)\b/i
/** Meta's customer-data keys: each leaves the server only as a sha256 digest. */
const MATCH_KEYS = ["em", "fn", "ln", "ct", "st", "zp", "country"] as const

/**
 * The masked text with every nested call's argument list blanked: what a call RETURNS reaches the request body, its
 * arguments do not (`adMatch: withPerson(base, { email })` sends digests). Arrow bodies and object literals are kept.
 */
export function bodyView(masked: string): string {
  const out = masked.split("")
  for (const match of masked.matchAll(/[\w$\])]\s*\(/g)) {
    const open = (match.index ?? 0) + match[0].length - 1
    if (out[open] !== "(") continue
    const close = closingOf(masked, open)
    if (close < 0) continue
    for (let index = open + 1; index < close; index += 1) if (out[index] !== "\n") out[index] = " "
  }
  return out.join("")
}

function piiIn(masked: string): { kind: "phone" | "detail"; key: string } | null {
  const phone = PHONE.exec(masked)
  if (phone) return { kind: "phone", key: phone[0].replace(/[{,:.\s]/g, "") }
  const body = bodyView(masked)
  const key = PII_KEYS.exec(body)
  if (key) return { kind: "detail", key: key[0].replace(/[\s:]/g, "") }
  return null
}

function adMatchUnhashed(value: string): string | null {
  const masked = maskCommentsAndStrings(value, true)
  if (!masked.trimStart().startsWith("{")) return null
  const props = objectProps(value, masked, masked.indexOf("{"))
  for (const key of MATCH_KEYS) {
    const entry = props.get(key)
    if (entry !== undefined && !HASHED.test(entry)) return key
  }
  return null
}

const STRIPE_WRITE = /\.\s*(?:checkout\s*\.\s*sessions|paymentIntents|subscriptions|invoices|paymentLinks|setupIntents)\s*\.\s*(?:create|update)\s*\(/g

/** Raw personal data in an outcome's request body, or in Stripe metadata; a phone anywhere in either. */
export function piiFindings(input: CommerceCheckInput): CommerceFinding[] {
  const findings: CommerceFinding[] = []
  for (const [file, text] of codeFiles(input.files)) {
    for (const outcome of outcomesIn(file, text)) {
      const { call } = outcome
      const line = call.line
      // A recipe reporter hashes its inputs (the lead's email, the payer read from Stripe); only the keys it sends are
      // read for personal data. A phone is flagged anywhere in the call.
      const sentText = outcome.reporter.sentKeys === null ? call.maskedArgs : outcome.props === null ? call.maskedArgs : [...outcome.props].filter(([key]) => outcome.reporter.sentKeys!.has(key)).map(([key, value]) => `${key}: ${maskCommentsAndStrings(value, true)}`).join(", ")
      const phone = PHONE.exec(call.maskedArgs)
      const hit = phone ? { kind: "phone" as const, key: phone[0].replace(/[{,:.\s]/g, "") } : piiIn(sentText)
      if (hit) {
        findings.push(
          hit.kind === "phone"
            ? { rule: "pii_in_outcome", state: "problem", file, line, message: `${where(file, line)} sends a phone number (${hit.key}) with the outcome; a phone number is never sent, in any form.` }
            : { rule: "pii_in_outcome", state: "problem", file, line, message: `${where(file, line)} puts a personal detail (${hit.key}) in the outcome sent to Infinite; only hashed match data may leave your server.` }
        )
        continue
      }
      const unhashed = outcome.props ? adMatchUnhashed(outcome.props.get("adMatch") ?? "") : null
      if (unhashed) {
        findings.push({ rule: "pii_in_outcome", state: "problem", file, line, message: `${where(file, line)} sends ${unhashed} unhashed in the match data; only a sha256 digest of it may leave your server.` })
        continue
      }
      for (const [key, value] of outcome.props ?? []) {
        if (key === "adMatch" || key.startsWith("...")) continue
        if (outcome.reporter.sentKeys !== null && !outcome.reporter.sentKeys.has(key)) continue
        const body = bodyView(maskCommentsAndStrings(value, true))
        if (PII_VALUES.test(body) && !HASHED.test(value)) {
          findings.push({ rule: "pii_in_outcome", state: "problem", file, line, message: `${where(file, line)} puts an email, name or phone in "${key}" of the outcome sent to Infinite.` })
          break
        }
      }
    }
    if (!isServerFile(file, text)) continue
    const masked = maskCommentsAndStrings(text, true)
    for (const match of masked.matchAll(STRIPE_WRITE)) {
      const open = (match.index ?? 0) + match[0].length - 1
      const close = closingOf(masked, open)
      if (close < 0) continue
      const args = masked.slice(open + 1, close)
      const body = bodyView(args)
      for (const meta of body.matchAll(/(?<![\w$])metadata\s*:\s*\{/g)) {
        const start = open + 1 + (meta.index ?? 0) + meta[0].length - 1
        const end = closingOf(masked, start)
        if (end < 0) continue
        const block = masked.slice(start, end + 1)
        const hit = piiIn(block)
        const values = bodyView(block).replace(/(?<![\w$])[A-Za-z_$][\w$]*\s*:/g, (entry) => " ".repeat(entry.length))
        const line = lineNumberAt(text, start)
        if (hit) {
          findings.push({ rule: "pii_in_stripe_metadata", state: "problem", file, line, message: hit.kind === "phone" ? `${where(file, line)} puts a phone number (${hit.key}) in the Stripe metadata; a phone number is never sent, in any form.` : `${where(file, line)} puts a personal detail (${hit.key}) in the Stripe metadata; keep only ids and the hashed or consented match data there.` })
        } else if (PII_VALUES.test(values)) {
          findings.push({ rule: "pii_in_stripe_metadata", state: "problem", file, line, message: `${where(file, line)} puts an email, name or phone in the Stripe metadata; keep only ids and the hashed or consented match data there.` })
        }
      }
    }
  }
  return findings
}

/** Every commerce rule over one input (the reviewer's view and the store end-to-end test). */
export function commerceFindings(input: CommerceCheckInput): CommerceFinding[] {
  return [
    ...(promiseFindings(input) ?? [
      { rule: "promise_missing" as const, state: "undetermined" as const, message: "The plan's event list is not known, so what it promised each tool could not be compared with the code." }
    ]),
    ...adMatchFindings(input),
    ...signalFindings(input),
    ...valueFindings(input),
    ...(doubleCountFindings(input) ?? [
      { rule: "double_count" as const, state: "undetermined" as const, message: "The code before this run could not be read, so new sends could not be told apart from the site's own." }
    ]),
    ...clickPathFindings(input),
    ...leaveFindings(input),
    ...(input.base ? deadCodeFindings(input) : []),
    ...leadFindings(input),
    ...metaEventIdFindings(input),
    ...piiFindings(input)
  ]
}

/**
 * The commerce rules over a whole change (the review step's `checks.json`, so the reviewer agent reads them): every
 * app file now, and before the change only the files it touched (`baseText`: text, null = new, undefined = unreadable).
 * A crash or an unreadable base never becomes a pass: it is one `undetermined` finding.
 */
export async function commerceFindingsForChange(input: {
  files: ReadonlyMap<string, string>
  changedPaths: readonly string[]
  baseText: (path: string) => Promise<string | null | undefined>
  inventory?: EventInventory | null
  metaInUse?: boolean
}): Promise<CommerceFinding[]> {
  const base = new Map<string, string | null>(input.files)
  let baseKnown = true
  for (const path of input.changedPaths) {
    const text = await input.baseText(path)
    if (text === undefined) baseKnown = false
    else base.set(path, text)
  }
  return commerceFindings({
    files: input.files,
    ...(baseKnown ? { base } : {}),
    ...(input.inventory ? { inventory: input.inventory } : {}),
    ...(input.metaInUse !== undefined ? { metaInUse: input.metaInUse } : {})
  })
}
