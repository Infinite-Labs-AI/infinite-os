// The review ledger (lane O4): `.infinite/wizard/review-ledger.json` (under the gitignore fence, 0600). It
// remembers, across rounds AND resumes, what the wizard declined (so an item raised again becomes an ASK, never
// a loop), which decisions are still open for the user, and which round ran on which head. The run state's
// `pr.handledThreadIds` stays the record of replied threads.
import type { ReviewResult } from "../wizard/contracts/agents.js"
import type { TriageDecision } from "./triage.js"
import { triageKey } from "./triage.js"

export const REVIEW_LEDGER_PATH = ".infinite/wizard/review-ledger.json"

export interface ReviewLedger {
  version: 1
  runId: string
  declined: Array<{ key: string; reason: string; round: number }>
  /** ASK items not yet answered: they go into the final comment under "You decide". */
  open: Array<{ key: string; path: string | null; reason: string; excerpt: string; round: number }>
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
    if (decision.action === "DECLINE" && !ledger.declined.some((entry) => entry.key === key)) {
      ledger.declined.push({ key, reason: decision.reason, round })
    }
    if (decision.action === "ASK" && !ledger.open.some((entry) => entry.key === key)) {
      ledger.open.push({ key, path: decision.item.path, reason: decision.reason, excerpt: decision.item.body.slice(0, 300), round })
    }
  }
}
