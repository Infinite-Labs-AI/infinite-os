import { ownerInformationOnly, protectedFinding, OWNER_INFORMATION_HEADING } from "./integrity.js"
// Triage of trusted review items (lane O4, §3g.4 step 4). Precedence: standing RULINGS > the wizard's
// DETERMINISTIC checks > the checklist > reviewer opinion. Each item becomes:
// - FIX: in scope and inside the run's allowlist → job 16 through the worker;
// - DECLINE: against a ruling, or contradicted by a passing deterministic check (the reply cites why);
// - ANSWER: a question, answered from this run's checks and receipts;
// - ASK: the user decides (conversion names, privacy text, widening the allowlist, two reviewers in
//   conflict, an item raised again after a DECLINE, a finding with no file). Never a loop.
import { isPolicyPath } from "../jobs/owner-boundary.js"
import type { ReviewChecklistItemId } from "../wizard/contracts/agents.js"
import { allowEntryMatches } from "../git/commit.js"
import { escapeRegExp } from "../text-escape.js"

/**
 * `INFINITE` (§3x.3): a finding on Infinite's own managed code or on the wizard's own change. It is never FIX (the
 * customer's agent never edits Infinite's runtime); it is replied to honestly and recorded for Infinite to fix.
 */
export type TriageAction = "FIX" | "DECLINE" | "ANSWER" | "ASK" | "INFINITE" | "SKIP" | "OWNER_INFO"
export type AskReason =
  | "conversion_names"
  | "privacy_text"
  | "owner_file"
  | "allowlist_widening"
  | "reviewer_conflict"
  | "raised_after_decline"
  | "unlocated"
  | "ruling_violation"
  /** LF4 close round 2 (P1-3): a finding on the page helper's call that says the conversion never reaches Infinite. */
  | "infinite_design"

export interface TriageItem {
  category?: "analytics" | "security" | "owner_consent_privacy" | "request_ga4_proxy" | "request_meta_unsupported" | "request_meta_deletion"
  source: "reviewer" | "teammate"
  threadId: string | null
  findingId: string | null
  item: ReviewChecklistItemId | null
  severity: "blocker" | "should" | "nit" | "question"
  path: string | null
  line: number | null
  /** The comment / finding text, already scanned. Quoted to the agent as data, never as instructions. */
  body: string
  suggestedFix: string | null
}

export interface TriageDecision {
  item: TriageItem
  action: TriageAction
  /** For DECLINE and ANSWER: the reply text; for ASK: why the user decides. */
  reason: string
  askReason?: AskReason
  ruling?: RulingId
  /** `INFINITE` only: whose code it is. */
  label?: "Infinite's own code" | "the wizard's own change"
  /** ASK only: Infinite's own rule the question quotes (a finding on the page helper's call: the server-only conversion). */
  rule?: string
  /**
   * Live-fix 4 final round (P3): the repo owner was asked and chose "Leave it". The item is decided, never "waiting on
   * the repo owner": its reply and the final comment say it was left, with Infinite's rule when the question quoted one.
   */
  leftByOwner?: true
}

/** The reason an ASK the repo owner chose to leave carries (its thread reply, the ledger and the final comment). */
export function leftByOwnerReason(decision: Pick<TriageDecision, "rule">): string {
  return `Left as it is: the repo owner chose not to have the agent change it.${decision.rule ? ` ${decision.rule}` : ""}`
}

export type RulingId = "banner_consent" | "ga4_proxy" | "meta_never_list" | "no_deletion"

interface Ruling {
  id: RulingId
  /**
   * The checklist item under which a finding REPORTS that the PR breaks this ruling. That is an ASK (the user
   * decides; a worker never edits consent, a GA4 proxy or the Meta never-list), never a FIX.
   */
  violationItem: ReviewChecklistItemId | null
  reply: string
}

/** The standing rulings (SHARED-BRIEF "Non-negotiable rules"; wf4 §3 triage precedence). */
export const RULINGS: readonly Ruling[] = [
  {
    id: "banner_consent",
    violationItem: "R6",
    reply: "Not changed: Infinite never adds, changes or checks a cookie banner or consent code. The consent mode is only recorded (standing ruling)."
  },
  {
    id: "ga4_proxy",
    violationItem: "R11",
    reply: "Not changed: there is no GA4 proxy (standing ruling); only PostHog goes through /ingest."
  },
  {
    id: "meta_never_list",
    violationItem: "R8",
    reply: "Not changed: this is on Meta's never-list (no phone numbers, no autoConfig, no test event codes, no page-built event IDs, no click-fired standard events, no synthesised _fbp)."
  },
  {
    id: "no_deletion",
    violationItem: null,
    reply: "Not changed: Infinite never deletes anything on Meta (standing ruling)."
  }
]

/** Only explicit requests can invoke a standing ruling; finding prose never grants that authority. */
export function rulingForCategory(category: TriageItem["category"]): Ruling | undefined {
  const id = category === "request_ga4_proxy" ? "ga4_proxy"
    : category === "request_meta_unsupported" ? "meta_never_list"
      : category === "request_meta_deletion" ? "no_deletion" : null
  return RULINGS.find(ruling => ruling.id === id)
}

const CONVERSION_NAMES = /conversion[\s_-]*name|rename[^.\n]{0,30}(conversion|event)|event name|name (the|this) (conversion|event)/i

/** Which passing wizard checks contradict a reviewer's opinion on an item (deterministic > opinion). */
export const DETERMINISTIC_CHECKS_BY_ITEM: Partial<Record<ReviewChecklistItemId, readonly string[]>> = {
  R2: ["census_one_per_tool", "census_posthog_init_once", "census_ga4_config_once", "census_meta_init_once", "one_beacon_per_tool"],
  R4: ["ga4_loader_id", "meta_pixel_once", "ids_match_connections"],
  R5: ["host_matrix", "preview_self_silent", "adopted_init_guarded", "meta_host_matrix"],
  // R4-5: per tool, the rehearsal's own page-change counts (`spaChecksNamed` keeps the ones the finding is about).
  R9: ["ga4_spa_page_view", "meta_spa_page_view"],
  R11: ["posthog_via_proxy_once", "next_rewrites_exact"],
  R12: ["csp_hosts", "no_csp_violation"],
  R13: ["build_green_or_baseline", "build"]
}

/**
 * R4-5 (live run 4): the review fix round spent its whole budget on three findings no customer agent can fix — Infinite's
 * helper never waiting for an adopted GA4 (`__infiniteGa4Lane`), "the signup never reaches Infinite's collector" (by
 * design: Infinite counts conversions from the server lane), and a wrong "Meta lacks SPA page views".
 *
 * LF4-P1-3: each is decided by WHAT the finding asks to change and WHERE, from the code, never by a keyword of its text.
 * Round 1: ownership comes FIRST, and Infinite's design is the narrow last step:
 *   1. where: a finding on a file Infinite owns (its managed runtime, the wizard's own change: `TriageContext.ownership`,
 *      from the install receipt) is Infinite's, whatever it says.
 *   2. what: a finding that names a name only Infinite's runtime defines (`TriageContext.infiniteInternalsIn`, derived
 *      from the installed runtime's own bytes, in Infinite's own namespace) asks to change Infinite's code. A helper the
 *      runtime EXPORTS (`infiniteTrackThenNavigate`) is the customer's to call right, and the helper module's path is
 *      never a reason either: a call-site bug names both.
 *   3. design: a finding ON the line of a page-helper call (a helper the installed runtime exports, called in the
 *      finding's own CLIENT file: `TriageContext.pageHelperCallsIn`) that says the conversion never reaches Infinite may
 *      be about Infinite's documented server-only conversion rule. LF4 close round 2 (P1-3): it is never DECLINED on its
 *      words (a page view lost to a reload, a GA4 double count, "/signup" in the text all read the same): the user is
 *      ASKED, with the server-lane explanation, and decides whether the rest of it is a bug in the page. A finding
 *      anywhere else (a late-mounted client, a server route, another line) goes through the normal rules.
 */
/** "… never reaches Infinite": what a finding says of the conversion (only ever read once the code above gates it). */
export const INFINITE_PAGE_CONVERSION =
  /\b(?:never|not|no)\b[^.\n]{0,80}\bInfinite(?:'s)?\s+(?:collector|ledger|lane)\b|\bInfinite(?:'s)?\s+(?:collector|ledger|lane)\b[^.\n]{0,60}\b(?:never|not|no)\b/i

export type FileRole = "server" | "client" | "other"

/**
 * LF4-P1-3: where a file runs, from its contents and the framework's file conventions (never the finding's words):
 * `server` = a route handler (`export … GET|POST|…`), a `"use server"` module, a Next `route` / `middleware` file or a
 * `pages/api` route; `client` = a `"use client"` module or a page the browser runs as-is (HTML, Vue, Svelte, Astro);
 * else `other` (a server component, a library: neither side can be told from the file).
 */
/** The file's leading `"use server"` / `"use client"` directive, past whitespace and comments, scanned in linear time. */
function leadingDirective(text: string): string | null {
  let i = 0
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i += 1
    if (text.startsWith("//", i)) {
      const end = text.indexOf("\n", i)
      if (end === -1) return null
      i = end + 1
    } else if (text.startsWith("/*", i)) {
      const end = text.indexOf("*/", i + 2)
      if (end === -1) return null
      i = end + 2
    } else break
  }
  const match = /^["'](use (?:server|client))["']/.exec(text.slice(i, i + 14))
  return match ? match[1]! : null
}

export function fileRoleOf(path: string, text: string): FileRole {
  const directive = leadingDirective(text)
  if (directive === "use server") return "server"
  if (/\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|\bexport\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=/.test(text)) return "server"
  if (/(?:^|\/)(?:route|middleware)\.[cm]?[jt]s$|(?:^|\/)pages\/api\//.test(path)) return "server"
  if (directive === "use client") return "client"
  if (/\.(?:html?|vue|svelte|astro)$/i.test(path)) return "client"
  return "other"
}

/** One call, in a customer file, of a helper Infinite's runtime exports, with the call's own string-literal arguments. */
export interface PageHelperCall {
  helper: string
  literals: string[]
  /** LF4 close round 2 (P1-3): the 1-based lines the call spans (its name to its closing parenthesis). */
  line: number
  endLine: number
}

/**
 * LF4-P1-3 (round 1): the calls `text` makes of the runtime's exported helpers (`helper(…)`), each with its string
 * literal arguments (the conversion's name, the URL it navigates to). Read from the file, never from a finding.
 */
export function pageHelperCalls(text: string, exported: Iterable<string>): PageHelperCall[] {
  const calls: PageHelperCall[] = []
  for (const helper of exported) {
    if (!/^[A-Za-z_$][\w$]*$/.test(helper)) continue
    const pattern = new RegExp(`(?<![\\w$.])${escapeRegExp(helper)}\\s*\\(([^()]*(?:\\([^()]*\\)[^()]*)*)\\)`, "g")
    for (const match of text.matchAll(pattern)) {
      const literals = [...match[1]!.matchAll(/(["'`])((?:(?!\1)[^\\\n]){1,80})\1/g)].map((literal) => literal[2]!)
      const line = text.slice(0, match.index).split("\n").length
      calls.push({ helper, literals, line, endLine: line + (match[0].match(/\n/g)?.length ?? 0) })
    }
  }
  return calls
}

/**
 * LF4 close round 2 (P1-3): the finding sits on a page-helper call's own lines in its own CLIENT file (never R10, the
 * server conversion job) and says the conversion never reaches Infinite. WHERE comes from the code (the call's lines),
 * never from a word of the finding: at 709c10b a finding that only said "signup" or "/signup" anywhere was declined.
 */
function onPageHelperCall(item: TriageItem, text: string, role: FileRole | null, calls: readonly PageHelperCall[]): boolean {
  if (item.item === "R10" || role !== "client" || item.line === null) return false
  const line = item.line
  return calls.some((call) => line >= call.line && line <= call.endLine) && INFINITE_PAGE_CONVERSION.test(text)
}

/**
 * LF4 close round 2 (P1-3): the ASK for a finding on the page helper's call that says the conversion never reaches
 * Infinite. It explains Infinite's server-twin conversion rule (and this run's server lane) and leaves the rest to the
 * user: the finding may also name a real bug in the page (a page view, a navigation, a GA4 or PostHog effect).
 */
export function infiniteDesignAsk(serverLaneInstalled: boolean | null | undefined): string {
  return `${infiniteConversionRule(serverLaneInstalled)} If the finding is also about something your page does (a page view, a navigation, GA4 or PostHog), that part may be a real bug: you decide whether the agent fixes it.`
}

/** Infinite's server-twin conversion rule, with this run's server lane said as it is. */
function infiniteConversionRule(serverLaneInstalled: boolean | null | undefined): string {
  const lane =
    serverLaneInstalled === true
      ? " This run's server lane is installed; the server conversion job wires it."
      : serverLaneInstalled === false
        ? " This run did not install the server lane, so Infinite has no conversion from this site yet: connect your Vercel project in Infinite and run npx infinite-tag again."
        : ""
  return `Infinite counts server-twin conversions from your server (the server lane's reportInfiniteOutcome); the page helpers send browser events to GA4, PostHog, Infinite's browser ledger and safe browser-only Meta events without building Meta event ids.${lane}`
}

/** The reply to "the page never sends the conversion to Infinite", with this run's server lane said as it is. */
export function infinitePageConversionReply(serverLaneInstalled: boolean | null | undefined): string {
  return `Not changed: ${infiniteConversionRule(serverLaneInstalled)}`
}

/** R4-5: R9 (SPA page views) is decided per tool the finding names, by that tool's own page-change check. */
export function spaChecksNamed(text: string): string[] {
  const out: string[] = []
  if (/\bGA4\b|\bgtag\b|\bGoogle Analytics\b|\bpage_view\b/i.test(text)) out.push("ga4_spa_page_view")
  if (/\bMeta\b|\bfbq\b|\bPageView\b|\bpixel\b/i.test(text)) out.push("meta_spa_page_view")
  if (/\bPostHog\b|\$pageview/i.test(text)) out.push("posthog_spa_page_view")
  return out
}

/** A finding's identity across rounds (wording changes between reviews; the file and item do not). */
export function triageKey(item: Pick<TriageItem, "path" | "item">): string {
  return `${item.path ?? "-"}|${item.item ?? "-"}`
}

export interface TriageContext {
  /** Repo-relative root for the direct policy-page path check. */
  appRoot?: string
  writtenByRun?: (path: string, line: number | null) => boolean
  /** The run's allowlist union (job `allow.files` ∪ `allow.create`). §3x.3: never the managed files. */
  allowlist: readonly string[]
  /**
   * §3x.3 Whose code a finding is on: Infinite's own managed code, the wizard's own change, or null (the customer's
   * code, which the normal rules triage). Absent = nothing is Infinite's.
   */
  ownership?: (path: string, line: number | null) => "Infinite's own code" | "the wizard's own change" | null
  /** Keys declined in an earlier round (from the review ledger). */
  declinedKeys: ReadonlySet<string>
  /** Check ids that PASSED on the current head (rehearsal, census, static, build). */
  passingChecks: ReadonlySet<string>
  /** Answers for ANSWER items, from receipts and check states; null when nothing measured answers it. */
  answerFor(item: TriageItem): string | null
  /** R4-5: the run's server lane is installed (the site has its secret); null/absent = unknown. */
  serverLaneInstalled?: boolean | null
  /**
   * LF4-P1-3: the names in `text` only Infinite's runtime defines (none that the finding's own file also uses). Absent
   * = none known (no runtime installed).
   */
  infiniteInternalsIn?: (text: string, path: string | null) => readonly string[]
  /** LF4-P1-3: the role of a repo file from its contents (`fileRoleOf`); null when it cannot be read. */
  fileRole?: (path: string) => FileRole | null
  /**
   * LF4-P1-3 (round 1): the calls a repo file makes of the installed runtime's exported helpers (`pageHelperCalls`).
   * Absent or empty = none (no runtime installed, or the file calls none): nothing is ever Infinite's design then.
   */
  pageHelperCallsIn?: (path: string) => readonly PageHelperCall[]
}

/** A plain repo-relative path: not absolute, no `..` segment, no backslash or control character. */
export function isRepoRelativePath(path: string): boolean {
  // eslint-disable-next-line no-control-regex
  if (path.length === 0 || path.length > 400 || /[\\\u0000-\u001f]/.test(path)) return false
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) return false
  return !path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
}

function inAllowlist(path: string, allowlist: readonly string[]): boolean {
  return allowlist.some((entry) => allowEntryMatches(entry, path))
}

export function triage(items: readonly TriageItem[], ctx: TriageContext): TriageDecision[] {
  // Two reviewers (the agent and a teammate) on the same line with different fixes → the user decides.
  const conflicts = new Set<TriageItem>()
  for (const a of items) {
    for (const b of items) {
      if (a === b || a.source === b.source || a.path === null || a.path !== b.path || a.line !== b.line) continue
      if ((a.suggestedFix ?? a.body).trim() !== (b.suggestedFix ?? b.body).trim()) {
        conflicts.add(a)
        conflicts.add(b)
      }
    }
  }
  return items.map((item): TriageDecision => {
    if (ownerInformationOnly(item)) return { item, action: "OWNER_INFO", reason: OWNER_INFORMATION_HEADING }
    const located = item.path !== null && isRepoRelativePath(item.path) ? item.path : null
    // LF4-P1-3 (round 1): OWNERSHIP FIRST. §3x.3 Infinite's own code and the wizard's own change are never handed to the
    // customer's agent, whatever the finding says.
    const owner = located !== null ? (ctx.ownership?.(located, item.line) ?? null) : null
    if (owner !== null) {
      return { item, action: "INFINITE", label: owner, reason: `This is ${owner} (${item.path}): recorded for Infinite to fix.` }
    }
    if (item.category === "owner_consent_privacy" && protectedFinding(item)) return { item, action: "ASK", askReason: "owner_file", reason: "The reviewer marked this finding as a blocker. It stays open for you; the wizard does not edit owner consent or policy code." }
    const text = `${item.body}\n${item.suggestedFix ?? ""}`
    const declinedBefore = ctx.declinedKeys.has(triageKey(item))
    // An explicit out-of-scope request is never offered as a worker FIX.
    const ruling = rulingForCategory(item.category)
    if (ruling) {
      if (protectedFinding(item)) return { item, action: "ASK", askReason: "ruling_violation", ruling: ruling.id, reason: "A blocker remains open for review; the wizard does not automatically dismiss it or perform the requested out-of-scope action." }
      if (declinedBefore) {
        return {
          item,
          action: "ASK",
          askReason: "raised_after_decline",
          ruling: ruling.id,
          reason: `${ruling.reply} It was raised again after the wizard declined it: you decide, outside the wizard.`
        }
      }
      return { item, action: "DECLINE", ruling: ruling.id, reason: ruling.reply }
    }

    if (located === null) return { item, action: "ASK", askReason: "unlocated", reason: "The finding has no safe file location, so it remains open for the site owner to scope." }
    if (isPolicyPath(located, ctx.appRoot)) return { item, action: "ASK", askReason: "owner_file", reason: "This finding remains open. Policy pages are read-only for the wizard; the site owner must address it." }

    // LF4-P1-3: a finding that asks to change a name only Infinite's runtime defines asks to change Infinite's code,
    // even on the customer's call line.
    const internals = ctx.infiniteInternalsIn?.(text, item.path) ?? []
    if (internals.length > 0) {
      return { item, action: "INFINITE", label: "Infinite's own code", reason: `This is about Infinite's own runtime (${internals[0]!.slice(0, 60)}), which your agent never edits: recorded for Infinite to fix.` }
    }
    // R4-5 / LF4 close round 2 (P1-3): a finding on the page helper's own call that says the conversion never reaches
    // Infinite is ASKED with the real reason (Infinite's server-only conversion rule), never declined on its words.
    const role = located !== null ? (ctx.fileRole?.(located) ?? null) : null
    const calls = located !== null ? (ctx.pageHelperCallsIn?.(located) ?? []) : []
    if (onPageHelperCall(item, text, role, calls)) {
      const rule = infiniteConversionRule(ctx.serverLaneInstalled)
      if (declinedBefore) return { item, action: "ASK", askReason: "raised_after_decline", reason: `${infiniteDesignAsk(ctx.serverLaneInstalled)} It was raised again after the wizard declined it.`, rule }
      return { item, action: "ASK", askReason: "infinite_design", reason: infiniteDesignAsk(ctx.serverLaneInstalled), rule }
    }
    if (declinedBefore) {
      return { item, action: "ASK", askReason: "raised_after_decline", reason: "Raised again after the wizard declined it: you decide, so the review never loops." }
    }
    if (conflicts.has(item)) {
      return { item, action: "ASK", askReason: "reviewer_conflict", reason: "Two reviewers suggest different changes on this line: you decide." }
    }
    if (CONVERSION_NAMES.test(text)) {
      return { item, action: "ASK", askReason: "conversion_names", reason: "Conversion names are your call; the wizard never changes them on a reviewer's say-so." }
    }
    if (item.severity === "question" && !protectedFinding(item)) {
      const answer = ctx.answerFor(item)
      return answer === null
        ? { item, action: "ASK", askReason: "unlocated", reason: "A question nothing this run measured can answer: you decide." }
        : { item, action: "ANSWER", reason: answer }
    }
    if (item.path === null) {
      return { item, action: "ASK", askReason: "unlocated", reason: "The comment names no file, so the wizard cannot scope a fix: you decide." }
    }
    if (!isRepoRelativePath(item.path)) {
      return { item, action: "ASK", askReason: "unlocated", reason: "The comment names a path outside the repo, so the wizard cannot scope a fix: you decide." }
    }
    if (!inAllowlist(item.path, ctx.allowlist)) {
      return {
        item,
        action: "ASK",
        askReason: "allowlist_widening",
        reason: `Fixing this means editing ${item.path}, which is outside the files this run may change: you decide.`
      }
    }
    // R4-5: an R9 finding is decided only by the page-change checks of the tools it names, and only when EVERY one passed.
    const named = item.item === "R9" ? spaChecksNamed(text) : null
    const deterministic = named ?? (item.item ? DETERMINISTIC_CHECKS_BY_ITEM[item.item] ?? [] : [])
    const passed = deterministic.filter((checkId) => ctx.passingChecks.has(checkId))
    const decides = named === null ? passed.length > 0 : named.length > 0 && passed.length === named.length
    if (decides && !protectedFinding(item) && item.category === "analytics") {
      return {
        item,
        action: "DECLINE",
        reason: `Not changed: the wizard's own check${passed.length > 1 ? "s" : ""} ${passed.join(", ")} passed on this commit, and its checks outrank a reviewer's opinion.`
      }
    }
    return { item, action: "FIX", reason: "In scope and inside the allowlist." }
  })
}
