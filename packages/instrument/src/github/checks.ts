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
  deploymentState?: string
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
    pass: checks.filter((check) => check.bucket === "pass").length,
    fail: checks.filter((check) => check.bucket === "fail" && !blockedPreview(check)).length,
    pending: checks.filter((check) => check.bucket === "pending" || check.bucket === "cancel").length,
    total: checks.length
  }
}

/** Hosting access failures do not measure either the code or its preview. */
export function blockedPreview(check: PrCheck): boolean {
  if (!/vercel|netlify|cloudflare/i.test(check.name)) return false
  if (check.deploymentState) return check.deploymentState.toLowerCase() === "blocked"
  return /^(?:Deployment (?:was |is |has been )?blocked|Authorization required|Vercel - Git author must have access to the project on Vercel to create deployments)\.?$/i.test((check.description ?? "").trim())
}

/** Read both Actions check runs and external commit statuses. An unreadable base is never green. */
export async function commitChecks(gh: GhClient, sha: string): Promise<PrCheck[]> {
  const [runs, statuses] = await Promise.all([
    gh.json<{ check_runs: Array<{ name: string; status: string; conclusion: string | null; details_url?: string }> }>(["api", `repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`]),
    gh.json<{ statuses: Array<{ context: string; state: string; description?: string; target_url?: string }> }>(["api", `repos/{owner}/{repo}/commits/${sha}/status?per_page=100`])
  ])
  const bucket = (state: string) => /^success$/.test(state) ? "pass" : /^(neutral|skipped)$/.test(state) ? "skipping" : /^(failure|error|timed_out|action_required)$/.test(state) ? "fail" : "pending"
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

/** Conservative trigger reader: unsupported YAML stays unknown and gets the full wait window. */
export function workflowPrTrigger(source: string): boolean | null {
  const match = /^(?:on|"on"|'on'):[ \t]*([^\n]*)(?:\n|$)/m.exec(source)
  if (!match) return null
  const rest = source.slice(match.index + match[0].length).split(/\n(?=[^\s#])/)[0] ?? ""
  const declaration = match[1]!.replace(/\s+#.*$/, "").trim()
  const value = declaration || rest
  if (/[&*!]|<<:/.test(value)) return null
  let events: string[]
  if (declaration) {
    events = declaration.replace(/^\[|\]$/g, "").split(",").map(word => word.trim().replace(/^['"]|['"]$/g, ""))
  } else {
    const lines = rest.split("\n").filter(line => line.trim() && !line.trimStart().startsWith("#"))
    if (lines.length === 0 || lines.some(line => /^ *\t/.test(line))) return null
    const indent = /^ +/.exec(lines[0]!)?.[0].length
    if (!indent) return null
    events = []
    for (const line of lines) {
      const depth = /^ */.exec(line)![0].length
      if (depth < indent) return null
      if (depth !== indent) continue
      const event = /^(?:([a-z_]+)|"([a-z_]+)"|'([a-z_]+)')\s*:/.exec(line.slice(indent))
      // Do not silently drop complex or escaped YAML keys: one might be a PR trigger.
      if (!event) return null
      events.push(event[1] ?? event[2] ?? event[3]!)
    }
  }
  if (events.length === 0) return null
  if (events.includes("pull_request") || events.includes("pull_request_target")) return true
  const known = new Set(["push", "schedule", "workflow_dispatch", "workflow_call", "workflow_run", "release", "merge_group", "repository_dispatch", "issues", "issue_comment", "create", "delete"])
  return events.every(event => known.has(event)) ? false : null
}

export async function checkRunsOnPr(gh: GhClient, check: PrCheck, sha: string): Promise<boolean | null> {
  const runId = /\/actions\/runs\/(\d+)/.exec(check.link ?? "")?.[1]
  if (!runId) return null
  try {
    const run = await gh.json<{ path?: string }>(["api", `repos/{owner}/{repo}/actions/runs/${runId}`])
    if (!run.path?.startsWith(".github/workflows/")) return null
    const file = await gh.json<{ content?: string; encoding?: string }>(["api", `repos/{owner}/{repo}/contents/${run.path}?ref=${encodeURIComponent(sha)}`])
    if (!file.content || file.encoding !== "base64") return null
    return workflowPrTrigger(Buffer.from(file.content, "base64").toString("utf8"))
  } catch { return null }
}


/** Read a complete paginated collection; a partial inventory cannot prove that CI is finished. */
async function collection<T>(gh: GhClient, path: string, key: string): Promise<T[]> {
  const rows: T[] = []
  for (let page = 1; page <= 20; page++) {
    const response = await gh.json<Record<string, unknown>>(["api", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`])
    const entries = response[key]
    if (!Array.isArray(entries)) throw new Error("GitHub returned an unreadable check inventory")
    rows.push(...entries as T[])
    const total = typeof response.total_count === "number" ? response.total_count : null
    if (total !== null ? rows.length >= total : entries.length < 100) return rows
    if (entries.length === 0) break
  }
  throw new Error("GitHub check inventory was incomplete")
}

interface HeadRun { id: number; head_sha: string; status: string; conclusion: string | null; path?: string; name?: string; event?: string; html_url?: string; app?: { slug?: string } }
export interface HeadCheckActivity { pending: string[]; failed: string[]; workflowPaths: string[]; observed: boolean; results: PrCheck[] }

/** Suites catch queued jobs before `gh pr checks` can see a job row. Runs catch queued workflows too. */
export async function headCheckActivity(gh: GhClient, sha: string): Promise<HeadCheckActivity> {
  const [suites, runs] = await Promise.all([
    collection<HeadRun>(gh, `repos/{owner}/{repo}/commits/${sha}/check-suites`, "check_suites"),
    collection<HeadRun>(gh, `repos/{owner}/{repo}/actions/runs?head_sha=${sha}`, "workflow_runs")
  ])
  const all = [...suites, ...runs]
  if (all.some(row => row.head_sha !== sha || !row.status)) throw new Error("GitHub checks did not identify this head SHA")
  const name = (row: HeadRun) => row.name ?? row.path ?? `${row.app?.slug ?? "Check suite"} ${row.id}`
  const results: PrCheck[] = []
  const failed: string[] = []
  // A red suite is not safely attributable to a base-red job by workflow name alone. Read its
  // actual failed jobs, or keep the unexplained suite failure blocking readiness.
  for (const row of all.filter(row => ["failure", "timed_out", "error", "action_required", "startup_failure"].includes(row.conclusion ?? ""))) {
    const isRun = runs.includes(row)
    const jobs = await collection<{ name: string; conclusion: string | null; details_url?: string; html_url?: string }>(gh,
      `repos/{owner}/{repo}/${isRun ? `actions/runs/${row.id}/jobs` : `check-suites/${row.id}/check-runs`}`, isRun ? "jobs" : "check_runs")
    const red = jobs.filter(job => ["failure", "timed_out", "error", "action_required", "startup_failure"].includes(job.conclusion ?? ""))
    if (red.length === 0) failed.push(name(row))
    results.push(...red.map(job => ({ name: job.name, bucket: "fail", state: job.conclusion!, link: job.details_url ?? job.html_url })))
  }
  return {
    pending: all.filter(row => row.status !== "completed" || !row.conclusion || ["cancelled", "canceled", "stale"].includes(row.conclusion)).map(name),
    failed,
    results,
    workflowPaths: runs.filter(row => row.status === "completed" && ["pull_request", "pull_request_target"].includes(row.event ?? "")).flatMap(row => row.path ? [row.path.split("@")[0]!] : []),
    observed: all.length > 0
  }
}

/** New PR-only workflows do not necessarily have a counterpart on the base commit. */
export async function headPrWorkflows(gh: GhClient, sha: string): Promise<{ expected: string[]; unknown: boolean }> {
  let files: Array<{ path: string; type: string }>
  try {
    files = await gh.json(["api", `repos/{owner}/{repo}/contents/.github/workflows?ref=${sha}`])
  } catch (error) {
    if (error instanceof GhError && error.kind === "not_found") return { expected: [], unknown: false }
    throw error
  }
  if (!Array.isArray(files)) throw new Error("GitHub workflow inventory was unreadable")
  const expected: string[] = []
  let unknown = false
  for (const entry of files) {
    if (entry.type !== "file" || !/\.ya?ml$/i.test(entry.path)) continue
    const file = await gh.json<{ content?: string; encoding?: string }>(["api", `repos/{owner}/{repo}/contents/${entry.path}?ref=${sha}`])
    const trigger = file.encoding === "base64" && file.content ? workflowPrTrigger(Buffer.from(file.content, "base64").toString("utf8")) : null
    if (trigger === true) expected.push(entry.path)
    if (trigger === null) unknown = true
  }
  return { expected, unknown }
}

/** Deployment status is a separate API: `gh pr checks` does not return it. */
export async function withDeploymentStates(gh: GhClient, sha: string, checks: PrCheck[]): Promise<PrCheck[]> {
  const provider = (name: string) => /^(vercel|netlify|cloudflare)(?:\b|[-:])/i.exec(name)?.[1]?.toLowerCase() ?? null
  if (!checks.some(check => provider(check.name))) return checks
  const deployments = await gh.json<Array<{ id: number; creator?: { login?: string }; environment?: string }>>(["api", `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=100`])
  if (!Array.isArray(deployments) || deployments.length >= 100) throw new Error("Deployment inventory could not be read completely")
  const evidence = (await Promise.all(deployments.map(async deployment => ({ deployment, status: (await gh.json<Array<{ state?: string; log_url?: string; environment_url?: string }>>(["api", `repos/{owner}/{repo}/deployments/${deployment.id}/statuses?per_page=100`]))[0] })))).filter(row => row.status?.state !== "inactive")
  const out: PrCheck[] = []
  for (const check of checks) {
    const host = provider(check.name)
    if (!host) { out.push(check); continue }
    const candidates = evidence.filter(({ deployment }) => provider(deployment.creator?.login ?? "") === host)
    const exact = evidence.filter(({ status }) => check.link && [status?.log_url, status?.environment_url].includes(check.link))
    if (candidates.length === 0 && exact.length === 0) { out.push(check); continue }
    const selected = exact.length === 1 ? exact[0] : candidates.length === 1 && checks.filter(row => provider(row.name) === host).length === 1 ? candidates[0] : null
    const state = selected?.status?.state?.toLowerCase() ?? "unknown"
    const bucket = ["queued", "pending", "in_progress", "waiting", "unknown"].includes(state) ? "pending" : ["failure", "error"].includes(state) ? "fail" : check.bucket
    out.push({ ...check, bucket, deploymentState: state })
  }
  return out
}
