// One way to build a `CheckResult` (§3e.7) for every check lane O9 owns: the T1 live checks, the
// setup checks seen through the wizard, the post-turn gate and `doctor`.
//
// THE STATES ARE THE CONTRACT. `pass | problem | undetermined | info`. Undetermined never counts as
// a pass and `info` never changes a score. A check that could not run (a fetch that failed, a parse
// that could not settle the question, a crash) is `undetermined` with the reason, never `pass`.
import type { CheckContext, CheckId, CheckResult, CheckTier, Evidence } from "../wizard/contracts/jobs.js"

export type CheckState = CheckResult["state"]

export function checkResult(
  checkId: CheckId,
  state: CheckState,
  tier: CheckTier,
  ctx: Pick<CheckContext, "runId" | "now">,
  details: { reason?: string; evidence?: Evidence[] } = {}
): CheckResult {
  return {
    checkId,
    state,
    ...(details.reason !== undefined ? { reason: details.reason } : {}),
    ...(details.evidence !== undefined && details.evidence.length > 0 ? { evidence: details.evidence } : {}),
    tier,
    at: ctx.now().toISOString(),
    runId: ctx.runId
  }
}

/**
 * Run one check so that a throw can never take the others down or read as a pass: a crash is
 * `undetermined (test error)`. (Incident: live checks hidden for about two weeks because one failing
 * step stopped the rest, c912fa5 / 21b78ab.)
 */
export async function isolated(
  checkId: CheckId,
  tier: CheckTier,
  ctx: Pick<CheckContext, "runId" | "now">,
  run: () => Promise<CheckResult[]>
): Promise<CheckResult[]> {
  try {
    return await run()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return [checkResult(checkId, "undetermined", tier, ctx, { reason: `test error: ${detail.slice(0, 200)}` })]
  }
}

/** Mask a public id for printing: enough to recognise it, never the whole value. */
export function maskIdentifier(value: string): string {
  if (!value) return ""
  if (value.length <= 10) return `${value.slice(0, 3)}...`
  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

/** Counts per state, plus how many checks did not run (undetermined with a test/fetch error). */
export function summarizeResults(results: readonly CheckResult[]): {
  pass: number
  problem: number
  undetermined: number
  info: number
  total: number
} {
  const count = (state: CheckState) => results.filter((result) => result.state === state).length
  return {
    pass: count("pass"),
    problem: count("problem"),
    undetermined: count("undetermined"),
    info: count("info"),
    total: results.length
  }
}
