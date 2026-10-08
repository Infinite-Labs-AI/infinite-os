// "How this job is checked": what the coding agent is told about the wizard's own checks of one job, so it is never
// surprised by a put-back (live run 2: the agent was never told that an unverified job is put back, that "undetermined"
// counts as unverified, or that checks also run after the deploy).
//
// Two kinds of check:
//   - the hard checks (tiers S, B, T0) run on the code after the agent's turn: a problem goes back to the agent with its
//     reason, and a problem still there when the rounds run out puts this job's edits back;
//   - the review agent's questions (the post-jobs review pass, `wizard/steps/jobs-review.ts`) are judgement calls: a "no" goes back to the agent
//     as a fix round, it never puts work back on its own.
import type { ChecklistItem, CheckTier } from "../wizard/contracts/jobs.js"
import { CHECK_LABELS } from "./check-words.js"
import { reviewQuestionTexts, type QuestionFacts } from "../review/questions.js"

/** Tiers whose problem can put the job's edits back (the wizard's own checks before the deploy). */
const PUT_BACK_TIERS: readonly CheckTier[] = ["S", "B", "T0"]
/** Tiers read after the deploy: they mark a job, never put its code back. */
const AFTER_DEPLOY_TIERS: readonly CheckTier[] = ["T1", "RH", "PV", "P"]

/**
 * The review agent's questions for one job, in plain words (`review/questions.ts`; the same questions the jobs' review
 * asks right after the agent's turns). `facts` (the run's inventory, approved names, hosts) makes them name the site's
 * own signal reader and the pages; without them the questions stay general.
 */
export function reviewQuestionsFor(item: ChecklistItem, facts: QuestionFacts = {}): readonly string[] {
  return reviewQuestionTexts(item, facts)
}

function labels(item: ChecklistItem, tiers: readonly CheckTier[]): string[] {
  return [...new Set(item.checks.filter((check) => tiers.includes(check.tier)).map((check) => CHECK_LABELS[check.id]).filter((label): label is string => typeof label === "string"))]
}

/** The hard checks of a job, in plain words (also returned by `job_list`). */
export function hardCheckLabels(item: ChecklistItem): string[] {
  return labels(item, PUT_BACK_TIERS)
}

/** The checks read after the deploy, in plain words. */
export function afterDeployCheckLabels(item: ChecklistItem): string[] {
  return labels(item, AFTER_DEPLOY_TIERS)
}

/** The brief's "How this job is checked" section for one job. */
export function howCheckedSection(item: ChecklistItem, questions: readonly string[] = reviewQuestionsFor(item)): string {
  const hard = hardCheckLabels(item)
  const later = afterDeployCheckLabels(item)
  const lines = ["How this job is checked:"]
  lines.push(
    hard.length > 0
      ? `- After your turn the wizard checks the code itself: ${hard.join("; ")}. A problem, or a check it cannot decide, comes back to you with the reason for another round. A problem still there when the rounds run out puts this job's edits back.`
      : "- The wizard has no check of its own to run on this job's code before the deploy, so the review agent decides it."
  )
  lines.push("- Every edit is checked against the Never list at once; an edit that breaks it, or lands outside this job's files, is put back.")
  if (later.length > 0) lines.push(`- After the deploy: ${later.join("; ")}. These never put your code back.`)
  lines.push(
    questions.length > 0
      ? `- The review agent will ask: ${questions.map((question) => question.trim()).join(" ")} A "no" comes back to you as a fix round; it never puts your work back by itself.`
      : "- The review agent then reads the whole change; a finding comes back to you as a fix round, never as a put-back."
  )
  return lines.join("\n")
}
