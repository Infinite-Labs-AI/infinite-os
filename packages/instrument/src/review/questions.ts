// The review agent's questions, one set per job: the judgements of MEANING that used to be static checks
// (`tracking_signal_carried`, `track_after_success`, `no_double_count`, `sends_before_leaving`, …) and that regex and
// AST read wrong in both directions (correct work put back, wrong work passed). Each question carries the facts the
// reviewer needs to answer it from the code: the files and lines, the site's own tracking-signal reader, the route a
// page posts to, what each tool already gets from the site.
//
// Built from the job item (its id, files, trigger evidence and inventory entries), the run's event inventory and the
// plan's facts, never from the coding agent. The jobs step asks them right after the agent's turns and before the edits
// settle (`wizard/steps/jobs-review.ts`); step 9's review sees them with their answers. A job is proven by the review
// when every question passes; any other answer keeps its edits (a review answer never reverts anything).
import type { EventInventory, InventoryEvent, InventoryTool } from "../checks/commerce-inventory.js"
import { canonicalEvent, META_EVENT_NAMES } from "../checks/commerce-static.js"
import { OUTCOME_CONVERSION_TYPES } from "../jobs/detectors/outcomes.js"
import { COMMERCE_EVENTS_TARGET } from "../scan/event-inventory.js"
import type { ConversionType } from "../wizard/contracts/bridge.js"
import type { ChecklistItem, Evidence, JobId } from "../wizard/contracts/jobs.js"

/** One question about one job, with the facts it needs. */
export interface ReviewQuestion {
  /** The job item it belongs to. */
  itemId: string
  /** Stable within the item. */
  id: string
  text: string
}

/** What the run knows that the item does not carry (the jobs step reads it from the run's hand-off files). */
export interface QuestionFacts {
  /** The scan's event × tool inventory (what the site sends each tool, the page requests, the site's signal reader). */
  inventory?: EventInventory | null
  /** Meta gets this site's conversions; absent = assume it does (the founder's rule: every conversion to Meta). */
  metaInUse?: boolean
  /** The conversion names the user approved. */
  conversionNames?: readonly string[]
  /** The site's production hosts. */
  productionHosts?: readonly string[]
}

const TOOL_WORDS: Readonly<Record<InventoryTool, string>> = { meta: "Meta", ga4: "GA4", posthog: "PostHog", infinite: "Infinite" }
/** The browser commerce item's tool, by job. */
const COMMERCE_TOOL: Readonly<Partial<Record<JobId, InventoryTool>>> = { meta_improve: "meta", ga4_improve: "ga4", posthog_improve: "posthog" }
/** The conversions whose server route reads the page's tracking signal (a purchase reads what the checkout saved). */
const SIGNAL_EVENTS: ReadonlySet<InventoryEvent> = new Set<InventoryEvent>(["begin_checkout", "lead", "sign_up", "start_trial"])

const where = (entry: { file: string; line: number }) => `${entry.file}:${entry.line}`

function whereList(entries: ReadonlyArray<{ file: string; line: number }>, max = 4): string {
  const unique = [...new Map(entries.map((entry) => [where(entry), entry])).values()]
  return unique.slice(0, max).map(where).join(", ") + (unique.length > max ? ", …" : "")
}

function fileEvidence(evidence: readonly Evidence[]): Array<{ file: string; line: number }> {
  return evidence.flatMap((entry) => ("file" in entry ? [entry] : []))
}

function targetOf(item: Pick<ChecklistItem, "id">): string {
  const index = item.id.indexOf(":")
  return index < 0 ? "" : item.id.slice(index + 1)
}

/** The job's own files, as the reviewer should open them. */
function filesOf(item: Pick<ChecklistItem, "allow">): string {
  const list = [...new Set([...item.allow.files, ...item.allow.create].filter((file) => !file.includes("*")))]
  return list.length === 0 ? "the job's files" : list.slice(0, 6).join(", ") + (list.length > 6 ? ", …" : "")
}

/** What the site already sends each tool for `event` (the inventory's `already_sent` cells), in plain words. */
function siteSends(facts: QuestionFacts, item: Pick<ChecklistItem, "inventory">, event: InventoryEvent): string[] {
  const out: string[] = []
  const row = facts.inventory?.rows.find((entry) => entry.event === event)
  for (const [tool, cell] of Object.entries(row?.tools ?? {}) as Array<[InventoryTool, { state: string; siteEventName?: string; evidence?: Array<{ file: string; line: number }> }]>) {
    if (cell.state !== "already_sent") continue
    const name = cell.siteEventName ? ` as "${cell.siteEventName}"` : ""
    const at = cell.evidence?.length ? ` (${whereList(cell.evidence, 2)})` : ""
    out.push(`${TOOL_WORDS[tool]}${name}${at}`)
  }
  if (out.length > 0) return out
  // The item's own inventory entries (the scan's shape): the tools that already have sites for the event.
  for (const entry of item.inventory ?? []) {
    if (canonicalEvent(entry.event) !== event) continue
    for (const [tool, sites] of Object.entries(entry.tools)) {
      if (!sites || sites.length === 0) continue
      const words = tool === "meta_browser" || tool === "meta_server" ? "Meta" : TOOL_WORDS[tool as InventoryTool] ?? tool
      out.push(`${words} (${whereList(sites, 2)})`)
    }
  }
  return out
}

/** The once-per-action question for one event, naming what the site already sends. */
function onceQuestion(facts: QuestionFacts, item: ChecklistItem, event: InventoryEvent, label: string): ReviewQuestion {
  const already = siteSends(facts, item, event)
  return {
    itemId: item.id,
    id: "once",
    text:
      `Is the ${label} sent to each tool exactly once per user action, counting the site's own sends` +
      (already.length > 0 ? ` (the site already sends it to ${already.join("; ")})` : "") +
      `, and counting any helper the action goes through? This job must not add a second send of it to a tool that already gets it.`
  }
}

/** The page → route request facts for a server route, and the site's own signal reader. */
function signalQuestion(facts: QuestionFacts, item: ChecklistItem, event: InventoryEvent, routes: readonly string[]): ReviewQuestion | null {
  if (!SIGNAL_EVENTS.has(event) || facts.metaInUse === false) return null
  const signal = facts.inventory?.trackingSignal
  const reader =
    signal?.kind === "site_getter"
      ? `\`${signal.expression}\` (the site's own reader, exported by ${signal.file ? where({ file: signal.file, line: signal.line ?? 1 }) : "its tracking file"}; read it, never change it)`
      : signal?.kind === "always"
        ? "the value true (the site has no consent gate)"
        : signal?.kind === "tag_helper"
          ? "`infiniteAdMatchAllowed()` from the tag's page helpers"
          : "the site's own consent reader (or `infiniteAdMatchAllowed()` from the tag's page helpers when the site has none)"
  const requests = (facts.inventory?.pageRequests ?? []).filter((request) => routes.length === 0 || routes.includes(request.route))
  const how = { form: "a hidden field in the form it posts", json: "a key in the JSON body it sends", query: "a parameter in the URL", unknown: "the request" } as const
  const pages =
    requests.length > 0
      ? requests.map((request) => `${where(request)} (${request.via ?? request.how}) → ${request.route}, carried as ${how[request.how]}`).join("; ")
      : `the page that sends the request to ${routes.join(", ") || "the job's route"}`
  return {
    itemId: item.id,
    id: "signal",
    text:
      `Does ${pages} send the visitor's tracking-allowed signal, built from ${reader}, in the request the route reads, under the same key and in the ` +
      `same place, with the right polarity (allowed → true, anything else → false)? Is it read at the moment the request leaves: a posted form sets its hidden field ` +
      `in its own submit handler, a JSON fetch reads it while building the body, a URL is built when the request is made? A value computed when the page renders ` +
      `is wrong: a visitor who withdraws consent while on the page would still send match data. And does the route pass exactly that on as trackingAllowed?`
  }
}

/** The routes the job reports from (its trigger evidence and files on the server side). */
function routesOf(item: ChecklistItem): string[] {
  const files = [...item.allow.files, ...item.allow.create].filter((file) => /(?:^|\/)(?:pages\/api|app\/.*\/route\.|api|server|routes?)\b/.test(file))
  return [...new Set([...fileEvidence(item.trigger.evidence).map((entry) => entry.file).filter((file) => files.includes(file)), ...files])]
}

function serverConversionQuestions(item: ChecklistItem, facts: QuestionFacts): ReviewQuestion[] {
  const target = targetOf(item)
  const event = canonicalEvent(target) ?? (target as InventoryEvent)
  const label = event in META_EVENT_NAMES ? `${target} (Meta ${META_EVENT_NAMES[event as InventoryEvent]})` : target
  const trigger = fileEvidence(item.trigger.evidence)
  const at = trigger.length > 0 ? ` (the scan found it at ${whereList(trigger)})` : ""
  const routes = routesOf(item)
  const out: ReviewQuestion[] = []
  if (event === "purchase") {
    out.push({
      itemId: item.id,
      id: "after_success",
      text: `Is the purchase reported to Infinite only from the Stripe webhook route (${filesOf(item)}), after the webhook's signature check passes, and once per checkout session (the session id as its id, so a retried webhook counts once)? It must never be reported from the success page or the checkout route.`
    })
  } else if (event === "begin_checkout") {
    out.push({
      itemId: item.id,
      id: "after_success",
      text: `Is the checkout start reported to Infinite in ${filesOf(item)} only after the Stripe checkout session was created${at}, never before it and never from an error or catch branch, with the session id as its id?`
    })
  } else {
    out.push({
      itemId: item.id,
      id: "after_success",
      text: `Is the ${target} reported to Infinite in ${filesOf(item)} only after it succeeded${at} (after the request is validated and saved), never from an error or catch branch?`
    })
    out.push({
      itemId: item.id,
      id: "stable_id",
      text: `Does every ${target} report carry an id that stays the same when the same ${target} is reported again (an order, row or account id, or the lead recipe's fallbackId), never a random value, the time or a constant, so a retry counts once and nothing is dropped?`
    })
  }
  if (facts.metaInUse !== false) {
    out.push({
      itemId: item.id,
      id: "match_data",
      text: `Does the ${label} report carry the customer's match data for Meta (adMatch from adMatchFromRequest, or a recipe reporter that adds it itself: reportStripeCheckoutPurchase, reportStripeCheckoutStarted, reportInfiniteLead), hashed on the server, with no phone number in any form and no raw email or name in the request?`
    })
  }
  const signal = signalQuestion(facts, item, event, routes)
  if (signal) out.push(signal)
  if (event in META_EVENT_NAMES) out.push(onceQuestion(facts, item, event as InventoryEvent, target))
  return out
}

function conversionToolsQuestions(item: ChecklistItem, facts: QuestionFacts): ReviewQuestion[] {
  const target = targetOf(item)
  const event = canonicalEvent(target)
  const trigger = fileEvidence(item.trigger.evidence)
  const names = (facts.conversionNames ?? []).filter((name) => name === target || canonicalEvent(name) === event)
  const call = `the ${JSON.stringify(names[0] ?? target)} conversion's infiniteTrack call`
  const out: ReviewQuestion[] = []
  if (OUTCOME_CONVERSION_TYPES.has(target as ConversionType)) {
    out.push({
      itemId: item.id,
      id: "after_success",
      text: `Is ${call} made only inside the success branch of ${trigger.length > 0 ? whereList(trigger) : filesOf(item)} (after the request succeeded, for example after an \`if (!res.ok) return\` guard), before any navigation, and never on the link or button that leads to the form?`
    })
  } else {
    out.push({
      itemId: item.id,
      id: "on_click",
      text: `Is ${call} made from the click itself (${trigger.length > 0 ? whereList(trigger) : filesOf(item)}), and does no click fire a standard Meta event (fbq('track', …)) straight from the page?`
    })
  }
  if (event) out.push(onceQuestion(facts, item, event, target))
  return out
}

function commerceQuestions(item: ChecklistItem, facts: QuestionFacts, tool: InventoryTool): ReviewQuestion[] {
  const events = [...new Set((item.inventory ?? []).map((entry) => canonicalEvent(entry.event)).filter((event): event is InventoryEvent => event !== null))]
  const names = events.map((event) => (tool === "meta" ? META_EVENT_NAMES[event] : event))
  const sites = (item.inventory ?? []).flatMap((entry) => entry.sites)
  const out: ReviewQuestion[] = [
    {
      itemId: item.id,
      id: "promised",
      text: `Does the code now send ${TOOL_WORDS[tool]} ${names.join(" and ") || "the events this job adds"}${sites.length > 0 ? ` from where the site's own events happen (${whereList(sites)})` : ""}, each with the product id, value and currency?`
    }
  ]
  const already = events.flatMap((event) => siteSends(facts, item, event).map((words) => `${event}: ${words}`))
  out.push({
    itemId: item.id,
    id: "once",
    text:
      `Is each of these events sent to ${TOOL_WORDS[tool]} exactly once per user action, counting the site's own sends` +
      (already.length > 0 ? ` (${already.join("; ")})` : "") +
      ` and any helper the click goes through (a send inside the site's helper AND another in the handler that calls it counts twice)?`
  })
  if (tool === "meta") {
    const leaving = sites.filter((site) => site.navigation === "full_load")
    out.push({
      itemId: item.id,
      id: "timing",
      text:
        `Does each Meta event really reach Meta: sent after the site's own pixel can take it (or held until the pixel starts)` +
        (leaving.length > 0 ? `, and, where the click leaves with a full page load (${whereList(leaving)}), awaited before the page leaves (infiniteLeaveAfter, infiniteTrackThenNavigate or a returned wait)?` : `, and before any full page load the click causes?`)
    })
  }
  out.push({
    itemId: item.id,
    id: "kept",
    text: "Does every function this job changed still run all of its own lines (no early return before the site's own sends), and does every send the site had before still run?"
  })
  return out
}

function identifyQuestions(item: ChecklistItem): ReviewQuestion[] {
  const trigger = fileEvidence(item.trigger.evidence)
  return [
    {
      itemId: item.id,
      id: "identify",
      text: `Is infiniteIdentify called with the account id (never an email, a name or a constant) only after the login is verified${trigger.length > 0 ? ` (${whereList(trigger)})` : ""}, and never from an error branch?`
    },
    { itemId: item.id, id: "reset", text: `Does every sign-out in ${filesOf(item)} call infiniteReset?` }
  ]
}

function previewGuardQuestions(item: ChecklistItem, facts: QuestionFacts): ReviewQuestion[] {
  const tool = targetOf(item)
  const words = tool === "ga4" ? "GA4" : tool === "posthog" ? "PostHog" : tool === "meta" ? "Meta pixel" : tool
  const hosts = facts.productionHosts?.length ? ` (${facts.productionHosts.slice(0, 4).join(", ")})` : ""
  return [
    {
      itemId: item.id,
      id: "guard",
      text: `Does the site's own ${words} start-up in ${filesOf(item)} now run only on the production hosts${hosts}, and stay silent on preview deployments, *.vercel.app and localhost, with the guard's test the right way round (production keeps sending)?`
    }
  ]
}

function setupFixQuestions(item: ChecklistItem, facts: QuestionFacts): ReviewQuestion[] {
  const trigger = fileEvidence(item.trigger.evidence)
  const at = trigger.length > 0 ? whereList(trigger) : filesOf(item)
  if (targetOf(item) === "silent_form") {
    const names = facts.conversionNames?.length ? ` (${facts.conversionNames.join(", ")})` : ""
    return [
      {
        itemId: item.id,
        id: "fixed",
        text: `Does the form at ${at} now send its conversion${names} once, only after its request succeeded, and never on top of a conversion the site's server already reports for that same form (a lead reported from its API route counts already)?`
      }
    ]
  }
  return [{ itemId: item.id, id: "fixed", text: `Is this fixed: "${item.title}" at ${at}, without adding a second send of any event?` }]
}

/**
 * The review questions for one job item (none for a job a mechanical check proves). Pure: the same item and facts give
 * the same questions, in the same order.
 */
export function reviewQuestionsFor(item: ChecklistItem, facts: QuestionFacts = {}): ReviewQuestion[] {
  // Repo text (file names, titles, the site's reader) rides inside the questions, and the questions ride inside the
  // coding agent's brief: a line break in a file name must never start a line of its own there.
  return questionsOf(item, facts).map((question) => ({ ...question, text: question.text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ") }))
}

function questionsOf(item: ChecklistItem, facts: QuestionFacts): ReviewQuestion[] {
  if (item.owner !== "agent") return []
  const jobId = item.jobId as JobId
  const commerceTool = targetOf(item) === COMMERCE_EVENTS_TARGET ? COMMERCE_TOOL[jobId] : undefined
  if (commerceTool) return commerceQuestions(item, facts, commerceTool)
  switch (jobId) {
    case "server_conversions":
      return serverConversionQuestions(item, facts)
    case "conversions_to_tools":
      return conversionToolsQuestions(item, facts)
    case "identify_reset":
      return identifyQuestions(item)
    case "preview_guard":
      return previewGuardQuestions(item, facts)
    case "setup_check_fixes":
      return setupFixQuestions(item, facts)
    default:
      return []
  }
}

/** A job the review agent proves (it has questions). */
export function reviewedByAgent(item: ChecklistItem, facts: QuestionFacts = {}): boolean {
  return reviewQuestionsFor(item, facts).length > 0
}

/** The questions' text alone (the coding agent's brief says what the review agent will ask: `jobs/how-checked.ts`). */
export function reviewQuestionTexts(item: ChecklistItem, facts: QuestionFacts = {}): string[] {
  return reviewQuestionsFor(item, facts).map((question) => question.text)
}
