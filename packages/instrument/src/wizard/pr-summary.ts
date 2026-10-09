// What the pull request DOES, in plain words (the founder's rule: screens say what we are doing, or the action left for
// the owner). Live run 3's report opened with "does not collect properly yet: 3 review blockers open (R10
// lib/infinite-outcome.ts:963 (the wizard's own change), …)": review ids, Infinite's own file, and not one word about
// what the pull request adds. Every report surface (report.md, the PR body and comments, the merge card, the terminal)
// now leads with the sentence built here, from the jobs that are done and the events each one carries, then the open
// items in plain sentences. Pure: typed inputs in, words out.
import { META_EVENT_NAMES } from "../checks/commerce-static.js"
import type { ChecklistItem, JobItemState } from "./contracts/jobs.js"
import type { FinishLineId, VerdictOpenFinding } from "./contracts/report.js"

/** Job states whose change is in the pull request (`claimed` is not: the wizard could not check it). */
const IN_THE_CODE: readonly JobItemState[] = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven"]

/** Each finish-line check in plain words (never its id). */
export const FINISH_LINE_WORDS: Readonly<Record<FinishLineId, string>> = {
  each_tool_once: "each tool counts a visit once",
  ids_match_connections: "the tool IDs in your code match your connections",
  previews_silent: "previews and local visits are not counted",
  survives_ad_blockers: "events get past ad blockers",
  spa_page_views: "page changes are counted",
  conversions_server_side: "conversions are sent from your server",
  identity_joined: "visits are joined to the signed-in account",
  utms_survive_redirects: "campaign tags survive redirects",
  consent_recorded: "the consent setting is recorded",
  csp_allows: "your security policy lets the tags load",
  ga4_key_events_received: "GA4 key events arrive",
  no_pii: "no personal data in any request",
  proof_from_real_visit: "a real visit was received",
  keeps_being_checked: "the 7-day check-in"
}

/** Where each browser commerce event is sent from, as the owner knows the page. */
const BROWSER_PLACE: Readonly<Partial<Record<string, string>>> = {
  view_item: "on product pages",
  add_to_cart: "on add-to-cart buttons",
  begin_checkout: "when checkout starts",
  purchase: "on the order confirmation",
  lead: "on the sign-up form",
  sign_up: "when an account is created",
  start_trial: "when a trial starts"
}

/** A server conversion in the owner's words (plural: "sends purchases"). */
const SERVER_WORDS: Readonly<Record<string, string>> = {
  begin_checkout: "checkout starts",
  purchase: "purchases",
  lead: "sign-ups",
  sign_up: "new accounts",
  start_trial: "trial starts",
  subscribe: "subscriptions",
  add_payment_info: "payment details added"
}

/** The order a shop's conversions happen in (the sentence lists them that way). */
const SERVER_ORDER = ["begin_checkout", "add_payment_info", "purchase", "subscribe", "start_trial", "sign_up", "lead"]

/** What a server conversion carries to Meta. */
const COMMERCE = new Set(["begin_checkout", "purchase", "start_trial", "subscribe", "add_payment_info"])

const TOOL_WORDS: Readonly<Record<string, string>> = { ga4: "GA4", posthog: "PostHog" }

/** "a", "a and b", "a, b and c". */
export function andWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join("")
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`
}

const target = (item: Pick<ChecklistItem, "id">): string => item.id.slice(item.id.indexOf(":") + 1)

/**
 * The one sentence a report opens with: what this pull request adds, built from the jobs whose change is in the code
 * and the events each one carries. Null when no job's change is in the code (nothing to say it does).
 *
 * "Adds Meta ViewContent on product pages and AddToCart on add-to-cart buttons; sends checkout starts and purchases
 * (value, currency, products, customer match data) from a new payment webhook to Meta and Infinite."
 */
export function prDoesSentence(jobs: readonly ChecklistItem[], options: { metaInUse?: boolean } = {}): string | null {
  const done = jobs.filter((item) => IN_THE_CODE.includes(item.state))
  const clauses: string[] = []

  // The browser commerce events, per tool (Meta's from its own job, GA4's and PostHog's from theirs).
  const browser = (jobId: string) => done.find((item) => item.jobId === jobId && target(item) === "commerce_events")
  const metaBrowser = browser("meta_improve")
  if (metaBrowser) {
    const events = (metaBrowser.inventory ?? []).map((entry) => entry.event as string).filter((event) => event in META_EVENT_NAMES)
    const shown = events.length > 0 ? events : ["view_item", "add_to_cart"]
    clauses.push(`adds Meta ${andWords(shown.map((event) => `${META_EVENT_NAMES[event as keyof typeof META_EVENT_NAMES]} ${BROWSER_PLACE[event] ?? ""}`.trim()))}`)
  }
  for (const [jobId, tool] of [["ga4_improve", "ga4"], ["posthog_improve", "posthog"]] as const) {
    const item = browser(jobId)
    if (!item) continue
    const events = (item.inventory ?? []).map((entry) => (SERVER_WORDS[entry.event] ?? entry.event.replace(/_/g, " ")))
    clauses.push(`sends ${events.length > 0 ? andWords(events) : "shop events"} to ${TOOL_WORDS[tool]}`)
  }

  // The server conversions, reported from the site's server to Infinite (which relays them to Meta).
  const server = done.filter((item) => item.jobId === "server_conversions")
  if (server.length > 0) {
    const names = server.map(target).sort((a, b) => SERVER_ORDER.indexOf(a) - SERVER_ORDER.indexOf(b))
    const words = andWords(names.map((name) => SERVER_WORDS[name] ?? name.replace(/_/g, " ")))
    const meta = options.metaInUse !== false
    const carries = [...(names.some((name) => COMMERCE.has(name)) ? ["value, currency, products"] : []), ...(meta ? ["customer match data"] : [])].join(", ")
    const webhook = server.some((item) => target(item) === "purchase" && /new payment webhook/i.test(item.title))
    const from = webhook ? (names.length > 1 ? "your server and a new payment webhook" : "a new payment webhook") : "your server"
    clauses.push(`sends ${words}${carries ? ` (${carries})` : ""} from ${from} to ${meta ? "Meta and Infinite" : "Infinite"}`)
  }
  // Browser conversions sent to GA4 / PostHog where they were missing.
  for (const item of done.filter((entry) => entry.jobId === "conversions_to_tools")) {
    const name = target(item)
    const tools = (item.inventory?.[0]?.missing ?? []).filter((tool) => tool === "ga4" || tool === "posthog").map((tool) => TOOL_WORDS[tool]!)
    clauses.push(`sends ${SERVER_WORDS[name] ?? name.replace(/_/g, " ")} to ${tools.length > 0 ? andWords(tools) : "your analytics"}`)
  }
  if (done.some((item) => item.id === "meta_improve:capture")) clauses.push("saves Meta ad click ids when a visitor lands")
  // A layout job says what it adds in its own title ("Add the analytics rewrites to your Next config").
  for (const item of done.filter((entry) => entry.jobId === "unusual_layout" && /^Add /.test(entry.title))) clauses.push(`adds ${item.title.slice(4)}`)
  if (clauses.length === 0) return null
  const sentence = clauses.join("; ")
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`
}

/** The finding in the reviewer's own words: its first two sentences, at most 240 characters, on one line. */
export function findingSentence(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim()
  // A sentence ends at ".", "!" or "?" followed by a space ("posthog.com" and "/ingest." inside a path never end one).
  const text = flat.split(/(?<=[.!?])\s+/).slice(0, 2).map((part) => part.trim()).join(" ")
  return text.length > 240 ? `${text.slice(0, 239).trimEnd()}…` : text
}

/** Where a finding is, as the owner opens it: `path:line`, the path, or "the pull request". */
export function findingPlace(finding: Pick<VerdictOpenFinding, "path" | "line">): string {
  return finding.path === null ? "the pull request" : finding.line === null ? finding.path : `${finding.path}:${finding.line}`
}

/**
 * The review's open blockers on the OWNER's code: what the review agent asks the owner to look at. A finding on
 * Infinite's own files (a label) is never the owner's: it goes to Infinite (`infiniteFindings`).
 */
export function ownerReviewFindings(findings: readonly VerdictOpenFinding[]): VerdictOpenFinding[] {
  return findings.filter((finding) => finding.label === null && finding.severity === "blocker")
}

/** The review's other open suggestions on the owner's code ("should"): listed, folded, below the asks. */
export function ownerReviewSuggestions(findings: readonly VerdictOpenFinding[]): VerdictOpenFinding[] {
  return findings.filter((finding) => finding.label === null && finding.severity === "should")
}

/** The review's open findings on Infinite's own files: recorded for Infinite, never the owner's, never a blocker. */
export function infiniteFindings(findings: readonly VerdictOpenFinding[]): VerdictOpenFinding[] {
  return findings.filter((finding) => finding.label !== null)
}

/** "The review agent asks you to look at 2 things:" (the count in words up to ten). */
export function reviewAsksHeading(count: number): string {
  return `The review agent asks you to look at ${count === 1 ? "one thing" : `${count} things`}:`
}

/** One owner finding as a line: "pages/cart.tsx:71: The hidden field reads consent only when the page renders." */
export function reviewAskLine(finding: VerdictOpenFinding): string {
  return `${findingPlace(finding)}: ${finding.summary ? finding.summary : "the review agent flagged this place; open the review on the pull request for its words."}`
}

/** One finding on Infinite's own files, for Infinite (never the owner's to-do list). */
export function infiniteFindingLine(finding: VerdictOpenFinding): string {
  return `${findingPlace(finding)}: ${finding.summary ? finding.summary : "a review finding on Infinite's own file."}`
}

/** The heading of the owner's setup steps, by what they unlock. */
export function ownerStepsHeading(purchase: boolean): string {
  return purchase ? "Before purchases reach Meta, do these steps" : "Before your server conversions reach Meta, do these steps"
}
