// The review ledger (lane O4): `.infinite/wizard/review-ledger.json` (under the gitignore fence, 0600). It
// remembers, across rounds AND resumes, what the wizard declined (so an item raised again becomes an ASK, never
// a loop), which decisions are still open for the user, and which round ran on which head. The run state's
// `pr.handledThreadIds` stays the record of replied threads.
import type { ReviewChecklistItemId, ReviewResult } from "../wizard/contracts/agents.js"
import { ownerInformationOnly, protectedFinding } from "./integrity.js"
import type { ChecklistItem, JobItemState } from "../wizard/contracts/jobs.js"
import type { InfiniteOwnLabel } from "./post.js"
import type { TriageAction, TriageDecision } from "./triage.js"
import { RULINGS, isRepoRelativePath, rulingForCategory, triageKey } from "./triage.js"

export const REVIEW_LEDGER_PATH = ".infinite/wizard/review-ledger.json"

export interface ReviewLedger {
  version: 1
  checkRegistration?: { sha: string; complete: true }
  runId: string
  declined: Array<{ key: string; reason: string; round: number }>
  /** ASK items not yet answered: they go into the final comment under "You decide". */
  open: Array<{ key: string; path: string | null; reason: string; excerpt: string; round: number }>
  /** Live-fix 4 final round (P3): ASK items the repo owner was asked about and chose to leave (decided, never open). */
  left?: Array<{ key: string; path: string | null; reason: string; excerpt: string; round: number }>
  rounds: Array<{
    round: number
    reviewedSha: string
    reviewer: string
    fixSha: string | null
    /** The round's review after the scan (a resume re-triages it instead of re-running and re-posting it). */
    review?: ReviewResult
  }>
  /** Conversions already sent to the run as `clickTestedConversions` (a fix round PATCHes only new ones). */
  clickTested?: string[]
  /**
   * §3y.7: how complete the latest second review was (the merge card and the final comment say the same word).
   * `blind` = the reviewer could not read the files (no review was posted).
   */
  completeness?: { reviewer: string; state: "complete" | "incomplete" | "blind"; unchecked: string[] }
  /** §3x.3 Every trusted finding's latest triage (one per key): what `openFindings` reads. */
  findings?: LedgerFinding[]
  /** §3x.3 Written from `openFindings(ledger, jobs)` on every save: the findings that still stand. */
  openFindings?: OpenFinding[]
}

export interface LedgerFinding {
  category?: "analytics" | "security" | "owner_consent_privacy" | "request_ga4_proxy" | "request_meta_unsupported" | "request_meta_deletion"
  body?: string
  suggestedFix?: string | null
  key: string
  findingId: string | null
  item: ReviewChecklistItemId | null
  severity: "blocker" | "should" | "nit" | "question"
  path: string | null
  line: number | null
  action: TriageAction
  /** DECLINE: the standing ruling it cites (null = a decline from a passing check, which does not close it). */
  ruling: string | null
  label: InfiniteOwnLabel | null
  round: number
}

/** One finding that still stands (§3x.3): the verdict's `review_blocker_open` reads the blockers among them. */
export interface OpenFinding {
  findingId: string | null
  item: ReviewChecklistItemId | null
  severity: LedgerFinding["severity"]
  path: string | null
  line: number | null
  /** `Infinite's own code` / `the wizard's own change`, when the finding is on Infinite's files. */
  label: InfiniteOwnLabel | null
}

/** The job item states that close a FIX'd finding (its job-16 item was done and checked by the wizard). */
const CLOSING_STATES: readonly JobItemState[] = ["done_in_code", "waiting_deploy", "waiting_real_event", "proven", "not_needed"]

/**
 * §3x.3 / DECISIONS §1.5 THE one definition of an open review finding: every trusted finding that is not closed. Closed =
 * FIX'd and its `review_comments` item reached a done state; DECLINED citing a standing ruling; or ANSWERED from
 * receipts. An `INFINITE` finding stays open (it still describes the shipped code), labelled. A ledger written before
 * this field existed is read from its rounds' reviews (every reviewer finding is trusted), so an old run's open
 * findings are never silently zero. `ownership` labels a finding the ledger recorded no label for.
 */
export function openFindings(
  ledger: Pick<ReviewLedger, "rounds" | "declined" | "findings">,
  jobs: readonly Pick<ChecklistItem, "id" | "state">[],
  ownership?: (path: string, line: number | null) => InfiniteOwnLabel | null,
  writtenByRun?: (path: string, line: number | null) => boolean
): OpenFinding[] {
  const latest = new Map<string, LedgerFinding>()
  if (ledger.findings && ledger.findings.length > 0) {
    for (const finding of ledger.findings) {
      // Older ledgers omitted suggestions from their triage rows; recover only that
      // scope evidence from the matching saved review before deciding to close it.
      const original = ledger.rounds.find(round => round.round === finding.round)?.review?.findings.find(entry => entry.id === finding.findingId && triageKey(entry) === finding.key)
      latest.set(findingKey(finding.key, finding.findingId), { ...finding, suggestedFix: finding.suggestedFix ?? original?.suggested_fix })
    }
  } else {
    const rulingReplies = new Set(RULINGS.map((ruling) => ruling.reply))
    for (const round of ledger.rounds) {
      for (const finding of round.review?.findings ?? []) {
        const key = triageKey({ path: finding.path, item: finding.item })
        const declined = ledger.declined.find((entry) => entry.key === key)
        latest.set(findingKey(key, finding.id), {
          key,
          findingId: finding.id,
          category: finding.category,
          body: finding.body,
          suggestedFix: finding.suggested_fix,
          item: finding.item,
          severity: finding.severity,
          path: finding.path,
          line: finding.line,
          action: ownerInformationOnly(finding) ? "OWNER_INFO" : declined ? "DECLINE" : "FIX",
          ruling: declined && rulingReplies.has(declined.reason) ? declined.reason : null,
          label: null,
          round: round.round
        })
      }
    }
  }
  const out: OpenFinding[] = []
  for (const finding of latest.values()) {
    if (finding.action === "ANSWER" && !protectedFinding(finding)) continue
    if (ownerInformationOnly(finding)) continue
    // Resumed ledgers can contain old keyword declines. Only a matching structured request
    // can still be closed; blockers and reports of a broken ruling stay open, as in fresh triage.
    const ruling = rulingForCategory(finding.category)
    if (finding.action === "DECLINE" && ruling && !protectedFinding(finding)

      && (finding.ruling === ruling.id || finding.ruling === ruling.reply)) continue
    if (finding.action === "FIX" && finding.findingId !== null) {
      const job = jobs.find((entry) => entry.id === `review_comments:${finding.findingId}`)
      if (job && CLOSING_STATES.includes(job.state)) continue
    }
    const label = finding.label ?? (finding.path !== null ? (ownership?.(finding.path, finding.line) ?? null) : null)
    out.push({ findingId: finding.findingId, item: finding.item, severity: finding.severity, path: finding.path, line: finding.line, label })
  }
  return out
}

/**
 * One finding's identity: its triage key (file + checklist item) and its finding id, so two findings of one round on
 * the same file and item (run 3's F7 and F8) are two, while a re-review that raises the same id again is one.
 */
function findingKey(key: string, findingId: string | null): string {
  return `${key}|${findingId ?? "-"}`
}

/** `<item> <path>:<line>` (+ the label), the verdict's name for an open finding. */
export function openFindingName(finding: { item: string | null; path: string | null; line: number | null; label: OpenFinding["label"] }): string {
  const where = finding.path === null ? "general" : finding.line === null ? finding.path : `${finding.path}:${finding.line}`
  return `${finding.item ?? "review"} ${where}${finding.label ? ` (${finding.label})` : ""}`
}

export function emptyLedger(runId: string): ReviewLedger {
  return { version: 1, runId, declined: [], open: [], rounds: [] }
}

export function parseLedger(text: string | null, runId: string): ReviewLedger {
  if (text === null) return emptyLedger(runId)
  try {
    const parsed = JSON.parse(text) as Partial<ReviewLedger>
    if (parsed.version !== 1 || parsed.runId !== runId || !Array.isArray(parsed.declined) || !Array.isArray(parsed.open) || !Array.isArray(parsed.rounds)) {
      return emptyLedger(runId)
    }
    return parsed as ReviewLedger
  } catch {
    return emptyLedger(runId)
  }
}

export function recordDecisions(ledger: ReviewLedger, decisions: readonly TriageDecision[], round: number): void {
  for (const decision of decisions) {
    const key = triageKey(decision.item)
    // §3x.3 every trusted finding's latest triage (one per key).
    const entry: LedgerFinding = {
      key,
      findingId: decision.item.findingId,
      category: decision.item.category,
      body: decision.item.body,
      suggestedFix: decision.item.suggestedFix,
      item: decision.item.item,
      severity: decision.item.severity,
      path: decision.item.path,
      line: decision.item.line,
      action: decision.action,
      ruling: decision.action === "DECLINE" ? (decision.ruling ?? null) : null,
      label: decision.label ?? null,
      round
    }
    ledger.findings = [...(ledger.findings ?? []).filter((existing) => findingKey(existing.key, existing.findingId) !== findingKey(key, entry.findingId)), entry]
    if (decision.action === "DECLINE" && !ledger.declined.some((entry) => entry.key === key)) {
      ledger.declined.push({ key, reason: decision.reason, round })
    }
    if (decision.action === "ASK" && decision.leftByOwner) {
      ledger.open = ledger.open.filter((entry) => entry.key !== key)
      if (!(ledger.left ?? []).some((entry) => entry.key === key)) {
        ledger.left = [...(ledger.left ?? []), { key, path: decision.item.path, reason: decision.reason, excerpt: decision.item.body.slice(0, 300), round }]
      }
      continue
    }
    if (decision.action === "ASK" && !ledger.open.some((entry) => entry.key === key)) {
      ledger.open.push({ key, path: decision.item.path, reason: decision.reason, excerpt: decision.item.body.slice(0, 300), round })
    }
  }
}
