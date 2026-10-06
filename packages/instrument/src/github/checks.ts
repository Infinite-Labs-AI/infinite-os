// CI checks on the PR (lane O4, §3g.2): read all reported checks because a failed site test matters
// even when branch protection marks no check required. gh exits 1 for failed and 8 for pending checks;
// both still print the JSON verdict.
import { GhError, type GhClient } from "./gh.js"

export interface PrCheck {
  name: string
  /** pass / fail / pending / skipping / cancel */
  bucket: string
  state: string
  description?: string
  link?: string
}

export async function prChecks(gh: GhClient, number: number): Promise<PrCheck[]> {
  try {
    const rows = await gh.json<Array<Partial<PrCheck>>>(
      ["pr", "checks", String(number), "--json", "name,bucket,state,description,link"],
      { okExitCodes: [1, 8] }
    )
    return rows.map((row) => ({ name: String(row.name ?? ""), bucket: String(row.bucket ?? ""), state: String(row.state ?? ""), description: row.description, link: row.link }))
  } catch (error) {
    // "no required checks reported" is an empty list, not a failure.
    if (error instanceof GhError && /no (required )?checks reported/i.test(`${error.result.stderr}${error.result.stdout}`)) return []
    throw error
  }
}

export function checksSummary(checks: readonly PrCheck[]): { pass: number; fail: number; pending: number; total: number } {
  return {
    pass: checks.filter((check) => check.bucket === "pass" || check.bucket === "skipping").length,
    fail: checks.filter((check) => check.bucket === "fail" && !blockedPreview(check)).length,
    pending: checks.filter((check) => check.bucket === "pending" || check.bucket === "cancel").length,
    total: checks.length
  }
}

/** Hosting access failures do not measure either the code or its preview. */
export function blockedPreview(check: PrCheck): boolean {
  return /vercel|netlify|cloudflare/i.test(check.name) && /deployment (?:was |is |has been )?blocked|(?:requires?|needs?) authori[sz]ation|authori[sz]ation required|git author.*(?:access|member)|must (?:be a member|have access)|(?:requires?|needs?|missing) team access/i.test(check.description ?? "")
}

/** Read both Actions check runs and external commit statuses. An unreadable base is never green. */
export async function commitChecks(gh: GhClient, sha: string): Promise<PrCheck[]> {
  const [runs, statuses] = await Promise.all([
    gh.json<{ check_runs: Array<{ name: string; status: string; conclusion: string | null; details_url?: string }> }>(["api", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`]),
    gh.json<{ statuses: Array<{ context: string; state: string; description?: string; target_url?: string }> }>(["api", `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`])
  ])
  const bucket = (state: string) => /^(success|neutral|skipped)$/.test(state) ? "pass" : /^(failure|error|timed_out|action_required)$/.test(state) ? "fail" : "pending"
  return [
    ...runs.check_runs.map(row => ({ name: row.name, bucket: bucket(row.conclusion ?? row.status), state: row.conclusion ?? row.status, link: row.details_url })),
    ...statuses.statuses.filter((row, index, all) => all.findIndex(other => other.context === row.context) === index).map(row => ({ name: row.context, bucket: bucket(row.state), state: row.state, description: row.description, link: row.target_url }))
  ]
}

export function checkPolicy(checks: readonly PrCheck[], base: readonly PrCheck[] | null): { failing: PrCheck[]; existing: PrCheck[]; blocked: PrCheck[] } {
  const blocked = checks.filter(blockedPreview)
  const red = checks.filter(check => check.bucket === "fail" && !blockedPreview(check))
  const existing = red.filter(check => {
    const matches = base?.filter(previous => previous.name === check.name) ?? []
    return matches.length > 0 && matches.every(previous => previous.bucket === "fail" && !blockedPreview(previous))
  })
  return { failing: red.filter(check => !existing.includes(check)), existing, blocked }
}
