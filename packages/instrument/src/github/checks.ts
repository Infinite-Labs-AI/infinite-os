// CI checks on the PR (lane O4, §3g.2): read all reported checks because a failed site test matters
// even when branch protection marks no check required. gh exits 1 for failed and 8 for pending checks;
// both still print the JSON verdict.
import { GhError, type GhClient } from "./gh.js"

export interface PrCheck {
  name: string
  /** pass / fail / pending / skipping / cancel */
  bucket: string
  state: string
}

export async function prChecks(gh: GhClient, number: number): Promise<PrCheck[]> {
  try {
    const rows = await gh.json<Array<{ name?: string; bucket?: string; state?: string }>>(
      ["pr", "checks", String(number), "--json", "name,bucket,state"],
      { okExitCodes: [1, 8] }
    )
    return rows.map((row) => ({ name: String(row.name ?? ""), bucket: String(row.bucket ?? ""), state: String(row.state ?? "") }))
  } catch (error) {
    // "no required checks reported" is an empty list, not a failure.
    if (error instanceof GhError && /no (required )?checks reported/i.test(`${error.result.stderr}${error.result.stdout}`)) return []
    throw error
  }
}

export function checksSummary(checks: readonly PrCheck[]): { pass: number; fail: number; pending: number; total: number } {
  return {
    pass: checks.filter((check) => check.bucket === "pass" || check.bucket === "skipping").length,
    fail: checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").length,
    pending: checks.filter((check) => check.bucket === "pending").length,
    total: checks.length
  }
}
