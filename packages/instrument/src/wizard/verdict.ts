// §3x.6 / DECISIONS §5.3 THE one verdict. Live run 3 printed "collects analytics properly now · 7 pass · 0 problems"
// while the duplicate GA4 tag and both unguarded tags were still on the live site: its headline read only the "Proven
// live" column, which graded only CONNECTED tools and never re-measured what the run had found before. This predicate
// reads everything the run knows — the three columns, every approved job, the review's open findings, and what the
// real visit measured of every INSTALLED tool — and is the only place a run may be called "properly". The tag, the
// cloud parser (its mirrored refusals) and the desktop (which never grades) all use its output.
//
// Rule: no claim without a measurement of the deployed site; no measurement thrown away; no default that hides a
// refusal. Pure: typed inputs in, one verdict out.
import { maskIdentifier } from "../checks/result.js"
import { openFindingName } from "../review/ledger.js"
import type { ChecklistItem, JobItemState } from "./contracts/jobs.js"
import {
  PROBLEM_REASON_KINDS,
  VERDICT_LIMITS,
  type Cell,
  type FinishLineId,
  type ReportColumnId,
  type ReportV2,
  type ReportVerdict,
  type VerdictOpenFinding,
  type VerdictReason,
  type VerdictReasonKind,
  type VerdictToolFact
} from "./contracts/report.js"
import type { TestTool } from "./contracts/test-engine.js"

/** What the real visit measured of ONE tool under test (the contract's type). */
export type ToolProofFact = VerdictToolFact

export interface VerdictInput {
  /** The production host, else the repo label. */
  site: string
  /** The finish line as the report holds it (all three columns). */
  finishLine: ReportV2["finishLine"]
  /** The proven column's meta (measured / pending), as the report holds it. */
  provenLive: ReportV2["columns"]["proven_live"]
  /** Every checklist item of the run (agent and code). */
  jobs: readonly ChecklistItem[]
  /** `openFindings(ledger, jobs)`: the review's findings that still stand. */
  openFindings: readonly VerdictOpenFinding[]
  /** Per tool under test, what the real visit measured; null = no real visit facts this run. */
  tools: readonly ToolProofFact[] | null
}

/** Job item states that are "in the code" (DECISIONS §5.3): `claimed` is NOT (the wizard could not check it). */
const DONE_STATES: readonly JobItemState[] = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven", "not_needed"]
/** Jobs that are not an approved plan line's fix: review fixes (their findings count instead) and build fixes. */
const NOT_PLAN_JOBS = new Set(["review_comments", "build_fix"])

const SILENT_LABEL: Record<TestTool, string> = { infinite: "Infinite pixel", ga4: "GA4", posthog: "PostHog", meta: "Meta pixel" }
const SHORT_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta" }

const label = (id: FinishLineId): string => id.replace(/_/g, " ")
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

/** At most 3 names, then `+N more` (DECISIONS §5.3). */
function listNames(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(", ")
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown
}

/** "GA4", "GA4 and Meta", "GA4, PostHog and Meta". */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join("")
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

function reason(kind: VerdictReasonKind, names: readonly string[], count = names.length): VerdictReason {
  return { kind, count, names: names.slice(0, VERDICT_LIMITS.namesMax).map((name) => name.slice(0, VERDICT_LIMITS.nameMaxChars)) }
}

/** The proven column measured the deployed site (the same test the headline has always used for "not checked live"). */
function provenMeasured(input: VerdictInput): boolean {
  const column = input.provenLive
  const measured = input.finishLine.some((line) => line.cells.proven_live.state === "pass" || line.cells.proven_live.state === "problem")
  return column.measuredAt !== null && column.pending === null && measured
}

/** The "not checked live yet" line (DECISIONS §5.3: today's words, unchanged). */
function notCheckedLiveHeadline(input: VerdictInput): string {
  const pending = input.provenLive.pending
  const why =
    pending === "deploy"
      ? " (waiting for the deploy)"
      : pending === "open_infinite"
        ? " (open Infinite to finish the live checks)"
        : pending === "rerun_tag"
          ? " (nothing in Infinite can finish it: run npx infinite-tag again once it is live)"
          : ""
  return `${input.site}: set up in the pull request · not checked live yet${why}`
}

/** The agent items of approved plan lines that are not in the code (an unanswered line's item is not approved). */
export function missingApprovedFixes(jobs: readonly ChecklistItem[]): ChecklistItem[] {
  return jobs.filter((item) => {
    if (item.owner !== "agent" || NOT_PLAN_JOBS.has(item.jobId)) return false
    if (DONE_STATES.includes(item.state)) return false
    // A plan line the user never answered seeds its item `blocked:needs_you` with no wizard note: not approved.
    if (item.state === "blocked" && item.blockedReason === "needs_you" && item.note === undefined) return false
    return true
  })
}

/** Finish-line problems found before the merge and not measured again after it. */
function earlierProblemsUnchecked(finishLine: VerdictInput["finishLine"]): string[] {
  return finishLine
    .filter((line) => {
      const before = (["live_today", "in_pr"] as ReportColumnId[]).some((column) => line.cells[column].state === "problem")
      if (!before) return false
      const live: Cell = line.cells.proven_live
      return live.state === "not_measured" || (live.state === "undetermined" && live.reason !== "not_connected")
    })
    .map((line) => label(line.id))
}

/** THE verdict (DECISIONS §5.3). */
export function computeVerdict(input: VerdictInput): ReportVerdict {
  const tools = input.tools ?? []
  const installed: ReportVerdict["installed"] = tools
    .filter((tool) => tool.installed || tool.connected)
    .map((tool) => ({ tool: tool.tool, ids: [...new Set(tool.ids)].map(maskIdentifier), connected: tool.connected }))
  const reasons: VerdictReason[] = []

  if (!provenMeasured(input)) {
    reasons.push(reason("not_live", []))
    const missing = missingApprovedFixes(input.jobs)
    if (missing.length > 0) reasons.push(reason("approved_fix_missing", missing.map((item) => item.title)))
    const blockers = input.openFindings.filter((finding) => finding.severity === "blocker")
    if (blockers.length > 0) reasons.push(reason("review_blocker_open", blockers.map(openFindingName)))
    return { state: "not_checked_live", headline: notCheckedLiveHeadline(input).slice(0, VERDICT_LIMITS.headlineMaxChars), reasons, installed }
  }

  const liveProblems = input.finishLine.filter((line) => line.cells.proven_live.state === "problem").map((line) => label(line.id))
  if (liveProblems.length > 0) reasons.push(reason("live_problem", liveProblems))
  const missing = missingApprovedFixes(input.jobs)
  if (missing.length > 0) reasons.push(reason("approved_fix_missing", missing.map((item) => item.title)))
  const blockers = input.openFindings.filter((finding) => finding.severity === "blocker")
  if (blockers.length > 0) reasons.push(reason("review_blocker_open", blockers.map(openFindingName)))
  const silent = tools.filter((tool) => tool.installed && !tool.fired && !tool.ungraded)
  if (silent.length > 0) reasons.push(reason("tool_silent", silent.map((tool) => SILENT_LABEL[tool.tool])))
  const withoutReceipt = tools.filter((tool) => tool.fired && tool.receipt === "no_receipt")
  if (withoutReceipt.length > 0) reasons.push(reason("tool_without_receipt", withoutReceipt.map((tool) => SILENT_LABEL[tool.tool])))
  const notConnected = tools.filter((tool) => tool.fired && !tool.connected && tool.tool !== "infinite")
  if (notConnected.length > 0) reasons.push(reason("tool_not_connected", notConnected.map((tool) => `${SHORT_LABEL[tool.tool]}${tool.ids[0] ? ` ${maskIdentifier(tool.ids[0])}` : ""}`)))
  const unchecked = earlierProblemsUnchecked(input.finishLine)
  if (unchecked.length > 0) reasons.push(reason("earlier_problem_unchecked", unchecked))
  const proof = input.finishLine.find((line) => line.id === "proof_from_real_visit")?.cells.proven_live

  const has = (kind: VerdictReasonKind) => reasons.find((entry) => entry.kind === kind)
  let state: ReportVerdict["state"]
  if (reasons.some((entry) => PROBLEM_REASON_KINDS.includes(entry.kind))) state = "problems"
  else if (has("tool_not_connected") || has("earlier_problem_unchecked") || proof?.state !== "pass") state = "unconfirmed"
  else state = "properly"

  let headline: string
  if (state === "problems") {
    const parts: string[] = []
    const live = has("live_problem")
    if (live) parts.push(`${live.count} ${plural(live.count, "problem", "problems")} on the live site (${listNames(liveProblems)})`)
    const fixes = has("approved_fix_missing")
    if (fixes) parts.push(`${fixes.count} approved ${plural(fixes.count, "fix is", "fixes are")} not in the code (${listNames(missing.map((item) => item.title))})`)
    const open = has("review_blocker_open")
    if (open) parts.push(`${open.count} review ${plural(open.count, "blocker", "blockers")} open (${listNames(blockers.map(openFindingName))})`)
    if (silent.length > 0) parts.push(`${listNames(silent.map((tool) => SILENT_LABEL[tool.tool]))} sent nothing on the real visit`)
    if (withoutReceipt.length > 0) parts.push(`no receipt from the real visit for ${listNames(withoutReceipt.map((tool) => SILENT_LABEL[tool.tool]))}`)
    headline = `${input.site} does not collect properly yet: ${parts.join(" · ")}`
  } else if (state === "unconfirmed") {
    const infinite = tools.find((tool) => tool.tool === "infinite")
    const infiniteIn = infinite !== undefined && (infinite.receipt === "verified" || infinite.receipt === "delivering")
    const waitingOn = tools.filter((tool) => tool.fired && tool.connected && (tool.receipt === null || tool.receipt === "pending" || tool.receipt === "undetermined"))
    headline = infiniteIn
      ? `${input.site}: Infinite's tag received this run's real visit`
      : `${input.site}: the real visit ran, but ${waitingOn.length > 0 ? `the receipts of ${andList(waitingOn.map((tool) => SHORT_LABEL[tool.tool]))} are` : "its receipts are"} not in`
    if (notConnected.length > 0) {
      const names = andList(notConnected.map((tool) => SHORT_LABEL[tool.tool]))
      const many = notConnected.length > 1
      headline += `; ${names} send, but ${many ? "their IDs are" : "its ID is"} not checked (not connected in Infinite)`
    }
    if (unchecked.length > 0) headline += ` · ${unchecked.length} earlier ${plural(unchecked.length, "problem", "problems")} not re-checked after the deploy (${listNames(unchecked)})`
    const ungraded = tools.filter((tool) => tool.installed && !tool.fired && tool.ungraded)
    if (ungraded.length > 0) headline += ` · ${andList(ungraded.map((tool) => SHORT_LABEL[tool.tool]))} could not be graded on the real visit`
  } else {
    const waiting = input.finishLine.filter((line) => {
      const cell = line.cells.proven_live
      return cell.state === "pending" && (cell.reason === "waiting_real_event" || cell.reason === "needs_7_days")
    }).length
    headline = `${input.site} collects analytics properly now${waiting > 0 ? ` · ${waiting} ${plural(waiting, "check waits", "checks wait")} for real visitors or the 7-day check-in` : ""}`
  }
  return { state, headline: headline.slice(0, VERDICT_LIMITS.headlineMaxChars), reasons, installed }
}

/**
 * §3x.6 (R3-6) What the pull request lacks that the plan approved, in the headline's own words (missing fixes, open
 * review blockers), or null when it lacks nothing: the merge card says "Ready to merge, but incomplete" with them.
 */
export function incompleteParts(verdict: Pick<ReportVerdict, "reasons">): string | null {
  const parts: string[] = []
  const fixes = verdict.reasons.find((entry) => entry.kind === "approved_fix_missing")
  if (fixes) parts.push(`${fixes.count} approved ${plural(fixes.count, "fix is", "fixes are")} not in the code (${listNames(fixes.names)})`)
  const blockers = verdict.reasons.find((entry) => entry.kind === "review_blocker_open")
  if (blockers) parts.push(`${blockers.count} review ${plural(blockers.count, "blocker", "blockers")} open (${listNames(blockers.names)})`)
  return parts.length > 0 ? parts.join(" · ") : null
}

/** §3x.6 The cloud PATCH the verdict allows: properly → proven, problems → problem, else undetermined. */
export function proofStateOf(verdict: Pick<ReportVerdict, "state">): "proven" | "problem" | "undetermined" {
  return verdict.state === "properly" ? "proven" : verdict.state === "problems" ? "problem" : "undetermined"
}

/** Words no verdict headline may carry (§3i.3 rule 3: those belong to cells with a receipt). */
export const VERDICT_FORBIDDEN_WORDS = /\b(?:verified|proven)\b/i

/** The refusals the cloud parser mirrors (DECISIONS §5.4); empty = a valid verdict. */
export function verdictErrors(report: Pick<ReportV2, "finishLine">, verdict: ReportVerdict): string[] {
  const errors: string[] = []
  if (verdict.headline.length === 0 || verdict.headline.length > VERDICT_LIMITS.headlineMaxChars) errors.push(`verdict.headline must be 1–${VERDICT_LIMITS.headlineMaxChars} characters`)
  if (VERDICT_FORBIDDEN_WORDS.test(verdict.headline)) errors.push('verdict.headline never says "verified" or "proven"')
  for (const entry of verdict.reasons) {
    if (entry.names.length > VERDICT_LIMITS.namesMax || entry.names.some((name) => name.length > VERDICT_LIMITS.nameMaxChars)) errors.push(`verdict.reasons ${entry.kind}: at most ${VERDICT_LIMITS.namesMax} names of ${VERDICT_LIMITS.nameMaxChars} characters`)
  }
  if (verdict.state === "properly") {
    if (report.finishLine.some((line) => line.cells.proven_live.state === "problem")) errors.push('verdict.state "properly" with a Proven-live problem cell')
    if (report.finishLine.find((line) => line.id === "proof_from_real_visit")?.cells.proven_live.state !== "pass") errors.push('verdict.state "properly" without a passing proof from the real visit')
    if (verdict.reasons.length > 0) errors.push('verdict.state "properly" with reasons')
  }
  if (verdict.state === "problems" && !verdict.reasons.some((entry) => PROBLEM_REASON_KINDS.includes(entry.kind))) errors.push('verdict.state "problems" without a problems-class reason')
  return errors
}
