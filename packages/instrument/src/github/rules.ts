// What the base branch requires before a merge (lane O4, §3g.4 "Teammates' own reviews"). Rulesets are
// readable without admin (`repos/{o}/{r}/rules/branches/<base>`); classic protection is not, so the PR's
// `reviewDecision` is the other signal (`""` = no review required; `REVIEW_REQUIRED` = a teammate must approve,
// because the user's own COMMENT review never counts).
import type { GhClient } from "./gh.js"

interface RawRule {
  type?: string
  parameters?: { required_approving_review_count?: number } | null
}

export function rulesFrom(rows: readonly RawRule[]): { requiresReview: boolean; mergeQueue: boolean } {
  return {
    requiresReview: rows.some((row) => row.type === "pull_request" && (row.parameters?.required_approving_review_count ?? 0) > 0),
    mergeQueue: rows.some((row) => row.type === "merge_queue")
  }
}

export async function baseRules(gh: GhClient, base: string): Promise<{ requiresReview: boolean; mergeQueue: boolean }> {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(base)) throw new Error("unsafe base")
  try {
    const rows = await gh.json<RawRule[]>(["api", `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(base)}`])
    return rulesFrom(Array.isArray(rows) ? rows : [])
  } catch {
    // Unreadable rules are not a block: the PR's reviewDecision still tells the user what is required.
    return { requiresReview: false, mergeQueue: false }
  }
}

/** The one line the user sees about what the base requires (null when nothing is required). */
export function mergeRequirementLine(input: { reviewDecision: string | null; requiresReview: boolean; mergeQueue: boolean }): string | null {
  if (input.mergeQueue) return "Merge with the queue; Infinite proves it after the queue merges."
  if (input.reviewDecision === "REVIEW_REQUIRED" || input.requiresReview) {
    return "A teammate must approve; your own review can only comment."
  }
  return null
}
