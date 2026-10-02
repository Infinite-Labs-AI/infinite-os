// Triage of trusted review items (lane O4, §3g.4 step 4). Precedence: standing RULINGS > the wizard's
// DETERMINISTIC checks > the checklist > reviewer opinion. Each item becomes:
// - FIX: in scope and inside the run's allowlist → job 16 through the worker;
// - DECLINE: against a ruling, or contradicted by a passing deterministic check (the reply cites why);
// - ANSWER: a question, answered from this run's checks and receipts;
// - ASK: the user decides (conversion names, privacy text, widening the allowlist, two reviewers in
//   conflict, an item raised again after a DECLINE, a finding with no file). Never a loop.
import type { ReviewChecklistItemId } from "../wizard/contracts/agents.js"
import { allowEntryMatches } from "../git/commit.js"

export type TriageAction = "FIX" | "DECLINE" | "ANSWER" | "ASK"
export type AskReason = "conversion_names" | "privacy_text" | "allowlist_widening" | "reviewer_conflict" | "raised_after_decline" | "unlocated"

export interface TriageItem {
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
}

export type RulingId = "banner_consent" | "ga4_proxy" | "meta_never_list" | "no_deletion"

interface Ruling {
  id: RulingId
  /** The checklist item under which a finding REPORTS a violation of this ruling (then it is a FIX: undo it). */
  violationItem: ReviewChecklistItemId | null
  pattern: RegExp
  reply: string
}

/** The standing rulings (SHARED-BRIEF "Non-negotiable rules"; wf4 §3 triage precedence). */
export const RULINGS: readonly Ruling[] = [
  {
    id: "banner_consent",
    violationItem: "R6",
    pattern: /cookie[\s-]*banner|consent[\s-]*(manager|banner|mode|gat(e|ing)|check|wall|pop-?up|platform|prompt|dialog)|\bCMP\b|onetrust|cookiebot|usercentrics|gtag\(\s*['"]consent/i,
    reply: "Not changed: Infinite never adds, changes or checks a cookie banner or consent code. The consent mode is only recorded (standing ruling)."
  },
  {
    id: "ga4_proxy",
    violationItem: "R11",
    pattern: /(proxy|first[\s-]party|reverse)[^.\n]{0,40}(ga4|gtag|google analytics|googletagmanager)|(ga4|gtag|google analytics)[^.\n]{0,40}proxy/i,
    reply: "Not changed: there is no GA4 proxy (standing ruling); only PostHog goes through /ingest."
  },
  {
    id: "meta_never_list",
    violationItem: "R8",
    pattern: /\bph\b[^.\n]{0,30}(fbq|advanced matching|meta|pixel)|phone[^.\n]{0,30}(meta|pixel|capi|advanced matching)|autoconfig[^.\n]{0,20}(true|on|enable)|enable[^.\n]{0,20}autoconfig|test_event_code|synthesi[sz]e[^.\n]{0,20}_fbp|fbq\(\s*['"]track['"][^.\n]{0,60}(click|onclick)|event[\s_]?id[^.\n]{0,30}(in the page|client[\s-]side|generate)/i,
    reply: "Not changed: this is on Meta's never-list (no phone numbers, no autoConfig, no test event codes, no page-built event IDs, no click-fired standard events, no synthesised _fbp)."
  },
  {
    id: "no_deletion",
    violationItem: null,
    pattern: /\bdelete\b[^.\n]{0,40}(pixel|dataset|campaign|ad set|ad account|meta)/i,
    reply: "Not changed: Infinite never deletes anything on Meta (standing ruling)."
  }
]

const CONVERSION_NAMES = /conversion[\s_-]*name|rename[^.\n]{0,30}(conversion|event)|event name|name (the|this) (conversion|event)/i
const PRIVACY_TEXT = /privacy[\s-]*(policy|text|paragraph|page|notice)/i

/** Which passing wizard checks contradict a reviewer's opinion on an item (deterministic > opinion). */
export const DETERMINISTIC_CHECKS_BY_ITEM: Partial<Record<ReviewChecklistItemId, readonly string[]>> = {
  R2: ["census_one_per_tool", "census_posthog_init_once", "census_ga4_config_once", "census_meta_init_once", "one_beacon_per_tool"],
  R4: ["ga4_loader_id", "meta_pixel_once", "ids_match_connections"],
  R5: ["host_matrix", "preview_self_silent", "adopted_init_guarded", "meta_host_matrix"],
  R9: ["ga4_one_page_view"],
  R11: ["posthog_via_proxy_once", "next_rewrites_exact"],
  R12: ["csp_hosts", "no_csp_violation"],
  R13: ["build_green_or_baseline", "build"]
}

/** A finding's identity across rounds (wording changes between reviews; the file and item do not). */
export function triageKey(item: Pick<TriageItem, "path" | "item">): string {
  return `${item.path ?? "-"}|${item.item ?? "-"}`
}

export interface TriageContext {
  /** The run's allowlist union (job `allow.files` ∪ `allow.create`) plus the managed files. */
  allowlist: readonly string[]
  /** Keys declined in an earlier round (from the review ledger). */
  declinedKeys: ReadonlySet<string>
  /** Check ids that PASSED on the current head (rehearsal, census, static, build). */
  passingChecks: ReadonlySet<string>
  /** Answers for ANSWER items, from receipts and check states; null when nothing measured answers it. */
  answerFor(item: TriageItem): string | null
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
    const text = `${item.body}\n${item.suggestedFix ?? ""}`
    if (ctx.declinedKeys.has(triageKey(item))) {
      return { item, action: "ASK", askReason: "raised_after_decline", reason: "Raised again after the wizard declined it: you decide, so the review never loops." }
    }
    for (const ruling of RULINGS) {
      if (!ruling.pattern.test(text)) continue
      // A finding that REPORTS a violation of the ruling (under its checklist item) asks to undo it: a fix.
      if (ruling.violationItem !== null && item.item === ruling.violationItem && item.path !== null && inAllowlist(item.path, ctx.allowlist)) break
      return { item, action: "DECLINE", ruling: ruling.id, reason: ruling.reply }
    }
    if (conflicts.has(item)) {
      return { item, action: "ASK", askReason: "reviewer_conflict", reason: "Two reviewers suggest different changes on this line: you decide." }
    }
    if (CONVERSION_NAMES.test(text)) {
      return { item, action: "ASK", askReason: "conversion_names", reason: "Conversion names are your call; the wizard never changes them on a reviewer's say-so." }
    }
    if (PRIVACY_TEXT.test(text)) {
      return { item, action: "ASK", askReason: "privacy_text", reason: "Privacy text is your call; the wizard inserts only the paragraph you approved." }
    }
    if (item.severity === "question") {
      const answer = ctx.answerFor(item)
      return answer === null
        ? { item, action: "ASK", askReason: "unlocated", reason: "A question nothing this run measured can answer: you decide." }
        : { item, action: "ANSWER", reason: answer }
    }
    if (item.path === null) {
      return { item, action: "ASK", askReason: "unlocated", reason: "The comment names no file, so the wizard cannot scope a fix: you decide." }
    }
    if (!inAllowlist(item.path, ctx.allowlist)) {
      return {
        item,
        action: "ASK",
        askReason: "allowlist_widening",
        reason: `Fixing this means editing ${item.path}, which is outside the files this run may change: you decide.`
      }
    }
    const deterministic = item.item ? DETERMINISTIC_CHECKS_BY_ITEM[item.item] ?? [] : []
    const passed = deterministic.filter((checkId) => ctx.passingChecks.has(checkId))
    if (passed.length > 0 && item.severity !== "blocker") {
      return {
        item,
        action: "DECLINE",
        reason: `Not changed: the wizard's own check${passed.length > 1 ? "s" : ""} ${passed.join(", ")} passed on this commit, and its checks outrank a reviewer's opinion.`
      }
    }
    return { item, action: "FIX", reason: "In scope and inside the allowlist." }
  })
}
