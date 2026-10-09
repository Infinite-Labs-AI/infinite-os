// The ONE rule for a second review that did not run (both review passes use it: the PR loop's step 9 and the
// post-jobs review pass). Live runs: the reviewer never ran (a refused request, reported as "did not match the
// schema"), yet the pull request was marked ready and merged 20 seconds later. So:
//   - a review that did not run, for ANY reason, keeps the pull request a draft;
//   - the words say "No second review ran on this pull request." and then the real reason, plainly; a refused
//     request never says "schema", and no check id or internal code is in the sentence;
//   - before giving up, the OTHER installed agent is asked once, read-only (Claude Code ↔ Codex).
// Pure: no I/O. The caller runs the reviews and hands the attempts in.
import { AGENT_LABEL } from "../agents/narration.js"
import { AGENT_LIMITS, type AgentDetectResult, type AgentKind, type ReviewFailure, type ReviewFailureKind } from "./contracts/agents.js"
import type { WizardCode } from "./contracts/codes.js"

export const NO_REVIEW_HEADLINE = "No second review ran on this pull request."

/** One reviewer run, after its one re-ask: a failure, or anything else (a parsed or classified review) = it ran. */
export interface ReviewAttempt {
  reviewer: AgentKind
  result: ReviewFailure | object
}

export interface ReviewOutcome {
  /** A usable review came back (from the first agent, or from the other one asked instead). */
  ran: boolean
  /** The agent whose review is usable; null when none ran. */
  reviewer: AgentKind | null
  /** Never mark the pull request ready: true exactly when no review ran. */
  keepDraft: boolean
  headline: typeof NO_REVIEW_HEADLINE | null
  /** Why the review(s) did not run, in plain words; "" when the first agent's review ran. */
  reasonWords: string
  /** The full sentence for the park/fail message and the terminal; "" when the first agent's review ran. */
  message: string
  /** The failure that ended it (the last attempt's kind); null when a review ran. Picks the step's outcome. */
  stoppedBy: ReviewFailureKind | null
  /** When the other agent reviewed instead: says so, and why the first did not. */
  note: string | null
}

const OTHER: Record<AgentKind, AgentKind> = { claude_code: "codex", codex: "claude_code" }

function isFailure(result: ReviewAttempt["result"]): result is ReviewFailure {
  return typeof result === "object" && result !== null && "error" in result && typeof result.error === "string"
}

/** Only an answer that came back and broke the format is asked again; no other failure has an answer to fix. */
export function shouldAskAgain(result: ReviewAttempt["result"]): boolean {
  return isFailure(result) && result.error === "unparseable"
}

/** Why one reviewer's review did not run, in plain words, starting with the agent's name. */
export function reviewFailureWords(reviewer: AgentKind, failure: ReviewFailure): string {
  const label = AGENT_LABEL[reviewer]
  const detail = failure.message?.trim().replace(/[.\s]+$/, "") ?? ""
  switch (failure.error) {
    case "rejected":
      // Never the service's own text: it names the schema, and the agent's answer did not break anything.
      return `${label}'s service refused the request`
    case "error":
      return detail ? `${label} stopped with an error: ${detail}` : `${label} stopped with an error`
    case "unavailable":
      return `${label} ${detail || "was not found on this computer"}`
    case "unparseable":
      return `${label}'s answer did not match the format twice`
    case "timeout":
      return `${label} ran out of time (${Math.round(AGENT_LIMITS.reviewer.wallMs / 60_000)} minutes)`
    case "out_of_usage":
      return `${label} is out of usage`
  }
}

/**
 * The other agent to ask, once, when `reviewer` failed with `failure`; null when there is none to ask. Out of usage
 * is NOT handed over: it parks the run with a clear resume ("run again when your plan resets") that gets the
 * intended cross-agent review; every other failure is not known to clear by waiting, so the other agent is asked.
 */
export function fallbackReviewer(reviewer: AgentKind, failure: ReviewFailure, usable: readonly AgentKind[], tried: readonly AgentKind[] = [reviewer]): AgentKind | null {
  if (failure.error === "out_of_usage") return null
  const other = OTHER[reviewer]
  return usable.includes(other) && !tried.includes(other) ? other : null
}

/** The agents usable as a reviewer in this run, from `AgentRunner.detect()` (an agent it lists unavailable is not). */
export function usableReviewers(detected: AgentDetectResult): AgentKind[] {
  const unusable = new Set((detected.unavailable ?? []).map((entry) => entry.kind))
  return [...new Set([detected.worker?.kind, detected.reviewer?.kind].filter((kind): kind is AgentKind => kind !== undefined && !unusable.has(kind)))]
}

/** What the attempts (in order: the first reviewer, then the one asked instead) add up to. */
export function reviewOutcome(attempts: readonly ReviewAttempt[]): ReviewOutcome {
  if (attempts.length === 0) throw new Error("reviewOutcome needs at least one attempt")
  const failures = attempts.filter((attempt): attempt is { reviewer: AgentKind; result: ReviewFailure } => isFailure(attempt.result))
  const reasons = failures.map((attempt, index) => (index === 0 ? reviewFailureWords(attempt.reviewer, attempt.result) : `Asked instead, ${reviewFailureWords(attempt.reviewer, attempt.result)}`))
  const reasonWords = reasons.join(". ")
  const success = attempts.find((attempt) => !isFailure(attempt.result))
  if (success) {
    return {
      ran: true,
      reviewer: success.reviewer,
      keepDraft: false,
      headline: null,
      reasonWords,
      message: "",
      stoppedBy: null,
      note: failures.length ? `${AGENT_LABEL[success.reviewer]} reviewed this pull request instead: ${reasonWords}.` : null
    }
  }
  return {
    ran: false,
    reviewer: null,
    keepDraft: true,
    headline: NO_REVIEW_HEADLINE,
    reasonWords,
    message: `${NO_REVIEW_HEADLINE} ${reasonWords}. The pull request stays a draft.`,
    stoppedBy: failures[failures.length - 1]!.result.error,
    note: null
  }
}

/** The step outcome code for a review that did not run (a code, never inside the sentence). */
export function reviewNotRunCode(kind: ReviewFailureKind): WizardCode {
  if (kind === "out_of_usage") return "INF_WIZ_AGENT_OUT_OF_USAGE"
  if (kind === "timeout") return "INF_WIZ_AGENT_TIMEOUT"
  if (kind === "unparseable") return "INF_WIZ_REVIEW_UNPARSEABLE"
  return "INF_WIZ_AGENT_FAILED"
}

/** How the review ledger's `completeness.unchecked` records a review that did not run (merge.ts reads it back). */
const NOT_RUN_PREFIX = "no review ran: "

export function notRunUnchecked(reasonWords: string): string {
  return `${NOT_RUN_PREFIX}${reasonWords}`
}

/** The reason words a ledger recorded with `notRunUnchecked`, or null. */
export function notRunReason(unchecked: readonly string[]): string | null {
  const entry = unchecked.find((text) => text.startsWith(NOT_RUN_PREFIX))
  return entry ? entry.slice(NOT_RUN_PREFIX.length) : null
}
