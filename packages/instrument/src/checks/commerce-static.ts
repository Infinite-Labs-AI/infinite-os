// The commerce static checks that stay BLOCKING: the mechanical rules only. After the agent's turns, does a purchase
// carry its value and currency, does a browser Meta event carry no page-made event id, and does no raw personal detail
// (or any phone) reach an outcome or the Stripe metadata?
//
// Each rule below reads source (comments never count; strings only where a name is read) and returns findings in
// plain words: they become the check's reason, the job note and the reviewer agent's input.
//   purchase_without_value — a purchase outcome without its value and currency;
//   page_built_meta_event_id — a browser Meta event carries an event id that is not the one the server got back;
//   pii_in_outcome / pii_in_stripe_metadata — a raw email, name, address or any phone reaches an outcome's request
//                            body or Stripe metadata. Only what REACHES the body counts: the arguments of a call
//                            inside it (`withPerson({ email })`, `adMatchFromRequest(req, { email })`) are inputs to a
//                            function whose RESULT is sent, so they are not flagged; a phone is flagged anywhere.
//
// The judgements these rules used to share this file with (every promised event is sent, nothing is counted twice, a
// send survives the page leaving, the page's tracking signal reaches the route, a report carries match data, a lead
// has a stable id) are the review agent's questions now (`review/questions.ts`): the regex versions got them wrong in
// both directions.
import { maskCommentsAndStrings } from "../frameworks/shared.js"
import { lineNumberAt } from "../harness/scan.js"
import { isServerFile } from "../jobs/detectors/outcomes.js"
import { findEventIdHits } from "../setup-checks/meta-event-id.js"
import { INVENTORY_EVENTS, type EventInventory, type InventoryEvent, type InventoryTool } from "./commerce-inventory.js"
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

export const COMMERCE_RULES = ["purchase_without_value", "page_built_meta_event_id", "pii_in_outcome", "pii_in_stripe_metadata"] as const
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

/** Every blocking commerce rule over one input (the reviewer's view of the static results, and the store end-to-end test). */
export function commerceFindings(input: CommerceCheckInput): CommerceFinding[] {
  return [...valueFindings(input), ...metaEventIdFindings(input), ...piiFindings(input)]
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
