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
//   purchase_without_value — a purchase outcome without its value and currency;
//   double_count           — the turn added a send of an event a tool already gets from the site (a new
//                            `gtag('event', X)`, `posthog.capture(X)`, `infiniteTrack(X)` that reaches GA4/PostHog, …);
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
}

/** The site's own wrappers, by name: `sendGa("x")`, `trackGoogleEvent("x")`, `capturePosthog("x")`, `trackMetaEvent("X")`. */
const WRAPPER_TOOLS: ReadonlyArray<{ tool: InventoryTool; pattern: RegExp }> = [
  { tool: "ga4", pattern: /^(?:ga4?|gtag|google)(?:[A-Z_]|$)|[a-z](?:Ga4?|GA4?|Gtag|Google)(?:[A-Z_]|$)/ },
  { tool: "posthog", pattern: /posthog/i },
  { tool: "meta", pattern: /^(?:meta|fb|pixel|facebook)(?:[A-Z_]|$)|[a-z](?:Meta|Fb|Fbq|Pixel|Facebook)(?:[A-Z_]|$)/ }
]
/** Never a wrapper: the tools' own functions (read on their own) and the tag's helpers. */
const NOT_A_WRAPPER = /^(?:gtag|fbq|infiniteTrack|infiniteTrackThenNavigate|infiniteMetaMirror|reportInfiniteOutcome|postInfiniteOutcome)$/

/** `destinations: { ga4: false }` (or `tools:`) in an options argument: the tool is skipped. */
function destinationOff(options: string, tool: InventoryTool): boolean {
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

/** The tag's `infiniteTrack(name, props, options)` / `infiniteTrackThenNavigate(…)`: the tools it reaches. */
function helperSends(call: Call, file: string, text: string): Send[] {
  const parts = splitTopLevelArgs(call.args)
  let name: string | null = null
  if (call.name === "infiniteTrack") name = parts[0] !== undefined ? literalString(parts[0]) : null
  else for (const part of parts) {
    const value = literalString(part)
    if (value !== null && /^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
      name = value
      break
    }
  }
  if (name === null) return []
  const raw = call.name === "infiniteTrack" ? (parts[2] ?? "") : (parts.filter((part) => part.trim().startsWith("{")).pop() ?? "")
  const options = maskCommentsAndStrings(namedObject(text, raw.trim()) ?? raw, false)
  const metaName = /\bmetaEventName\s*:\s*["'`]([A-Za-z]+)["'`]/.exec(options)?.[1] ?? null
  const event = canonicalEvent(name)
  const line = lineNumberAt(text, call.index)
  const out: Send[] = []
  if (event !== null) {
    for (const tool of ["ga4", "posthog", "infinite"] as const) if (!destinationOff(options, tool)) out.push({ tool, event, name, file, line, via: call.name })
  }
  const metaEvent = metaName !== null ? canonicalEvent(metaName) : event
  if (metaEvent !== null && (metaEvent === "view_item" || metaEvent === "add_to_cart") && !destinationOff(options, "meta")) {
    out.push({ tool: "meta", event: metaEvent, name: metaName ?? META_EVENT_NAMES[metaEvent], file, line, via: call.name })
  }
  return out
}

/** Every send of a known event in one file, per tool. */
export function sendsIn(file: string, text: string): Send[] {
  const out: Send[] = []
  const add = (tool: InventoryTool, name: string | null, index: number, via: string) => {
    if (name === null) return
    const event = canonicalEvent(name)
    if (event !== null) out.push({ tool, event, name, file, line: lineNumberAt(text, index), via })
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
  for (const call of callsOf(text, ["infiniteTrack", "infiniteTrackThenNavigate"])) out.push(...helperSends(call, file, text))
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

const OUTCOME_CALLS = ["reportInfiniteOutcome", "postInfiniteOutcome"] as const

export interface OutcomeCall {
  file: string
  call: Call
  /** The outcome's `type` as written, or null when it is computed. */
  type: string | null
  event: InventoryEvent | null
  props: Map<string, string> | null
}

export function outcomesIn(file: string, text: string): OutcomeCall[] {
  return callsOf(text, OUTCOME_CALLS).map((call) => {
    const props = topLevelProps(call)
    const raw = props?.get("type") ?? props?.get("eventName")
    const type = raw === undefined ? null : literalString(raw)
    return { file, call, type, event: type === null ? null : canonicalEvent(type), props }
  })
}

// ---------------------------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------------------------

export const COMMERCE_RULES = [
  "promise_missing",
  "outcome_without_ad_match",
  "purchase_without_value",
  "double_count",
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
      if (outcome.props === null) {
        findings.push({ rule: "outcome_without_ad_match", state: "undetermined", file, line: outcome.call.line, event: outcome.event, message: `${where(file, outcome.call.line)} passes a value the wizard cannot read, so whether the ${outcome.event} carries match data for Meta is unknown.` })
        continue
      }
      if (outcome.props.has("adMatch")) continue
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
      if (outcome.props === null) {
        findings.push({ rule: "purchase_without_value", state: "undetermined", file, line, event: "purchase", message: `${where(file, line)} passes a value the wizard cannot read, so whether the purchase carries its value and currency is unknown.` })
        continue
      }
      const value = moneyField(outcome.props, "value")
      const currency = moneyField(outcome.props, "currency")
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
      const hit = piiIn(call.maskedArgs)
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
    ...valueFindings(input),
    ...(doubleCountFindings(input) ?? [
      { rule: "double_count" as const, state: "undetermined" as const, message: "The code before this run could not be read, so new sends could not be told apart from the site's own." }
    ]),
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
