// CI checks on the PR (lane O4, §3g.2): read all reported checks because a failed site test matters
// even when branch protection marks no check required. gh exits 1 for failed and 8 for pending checks;
// both still print the JSON verdict.
import { GhError, type GhClient } from "./gh.js"

export interface PrCheck {
  name: string
  source?: "check_run" | "commit_status"
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
    fail: checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").length,
    pending: checks.filter((check) => check.bucket === "pending").length,
    total: checks.length
  }
}

/** Hosting access failures do not measure either the code or its preview. */
export function blockedPreview(check: PrCheck): boolean {
  if (!/vercel|netlify|cloudflare/i.test(check.name)) return false
  const deploymentState = check.deploymentState?.toLowerCase()
  if (deploymentState === "blocked") return true
  // GitHub compresses provider access failures into failure/error. Only these coarse states
  // may use an exact known access explanation; a specific native build failure stays failed.
  if (deploymentState && !["failure", "error"].includes(deploymentState)) return false
  return /^(?:Deployment (?:was |is |has been )?blocked|Authorization required(?: to deploy)?|Vercel - Git author must have access to the project on Vercel to create deployments)\.?$/i.test((check.description ?? "").trim())
}

/** Actual conclusions only. Neutral/skipped are unmeasured, never a passing execution. */
export function checkBucket(state: string): string {
  const value = state.toLowerCase()
  if (value === "success") return "pass"
  if (["neutral", "skipped"].includes(value)) return "skipping"
  if (["queued", "in_progress", "pending", "requested", "waiting"].includes(value)) return "pending"
  if (["failure", "error", "timed_out", "action_required", "cancelled", "canceled", "stale", "startup_failure", "blocked"].includes(value)) return "fail"
  return "unknown"
}

/** Read actual runs and commit statuses on this exact SHA; no suites or workflow-file inference. */
export async function commitChecks(gh: GhClient, sha: string): Promise<PrCheck[]> {
  const [runs, statuses] = await Promise.all([
    collection<{ name: string; head_sha: string; status: string; conclusion: string | null; details_url?: string; output?: { summary?: string } }>(gh, `repos/{owner}/{repo}/commits/${sha}/check-runs?filter=latest`, "check_runs"),
    collection<{ context: string; state: string; description?: string; target_url?: string }>(gh, `repos/{owner}/{repo}/commits/${sha}/status`, "statuses")
  ])
  if (runs.some(row => row.head_sha !== sha || typeof row.name !== "string" || !row.name || typeof row.status !== "string") ||
    statuses.some(row => typeof row.context !== "string" || !row.context || typeof row.state !== "string")) throw new Error("GitHub returned unreadable check runs or commit statuses for the head SHA")
  return [
    ...runs.map(row => {
      const state = row.status === "completed" ? row.conclusion ?? row.status : row.status
      return { name: row.name, source: "check_run" as const, bucket: checkBucket(state), state, link: row.details_url, ...(row.output?.summary ? { description: row.output.summary } : {}) }
    }),
    ...statuses.filter((row, index, all) => all.findIndex(other => other.context === row.context) === index).map(row => ({ name: row.context, source: "commit_status" as const, bucket: checkBucket(row.state), state: row.state, description: row.description, link: row.target_url }))
  ]
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

/** Deployment status is a separate API: match the explicit environment/project name, never URLs. */
export async function withDeploymentStates(gh: GhClient, sha: string, checks: PrCheck[]): Promise<PrCheck[]> {
  const provider = (name: string) => /^(vercel|netlify|cloudflare)(?:\b|[-:])/i.exec(name)?.[1]?.toLowerCase() ?? null
  const deployments = await gh.json<Array<{ id: number; creator?: { login?: string }; environment?: string }>>(["api", `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=100`])
  if (!Array.isArray(deployments) || deployments.length >= 100) throw new Error("Hosting deployment inventory could not be read completely")
  const evidence = await Promise.all(deployments.map(async deployment => {
    const statuses = await gh.json<Array<{ state?: string; description?: string | null }>>(["api", `repos/{owner}/{repo}/deployments/${deployment.id}/statuses?per_page=100`])
    if (!Array.isArray(statuses)) throw new Error("Hosting deployment statuses could not be read")
    return { deployment, status: statuses.find(status => status.state !== "inactive") }
  }))
  const normalize = (name: string) => name.trim().toLowerCase().replace(/\s*[-–—:]\s*/g, "-")
  const project = (name: string, prefix: string) => normalize(name.replace(new RegExp(`^${prefix}(?:\\s*[-–—:]\\s*|\\s+|$)`, "i"), ""))
  const mapped = checks.map(check => {
    const host = provider(check.name)
    if (!host || check.bucket === "skipping") return check
    // A deployment is separate evidence: an access block cannot erase an actual failed run.
    if (["fail", "cancel"].includes(check.bucket) && (check.source === "check_run" || Boolean(check.description?.trim())) && !blockedPreview(check)) return check
    const namedProject = project(check.name, host)
    const candidates = evidence.filter(({ deployment }) => provider(deployment.creator?.login ?? "") === host &&
      (!namedProject || normalize(deployment.environment ?? "") === namedProject || project(deployment.environment ?? "", "(?:preview|production)") === namedProject))
    // The API lists newest deployments first. Take one current attempt per environment.
    const latest = candidates.filter((entry, index) => candidates.findIndex(other => normalize(other.deployment.environment ?? "") === normalize(entry.deployment.environment ?? "")) === index)
    if (latest.length === 0) return check
    const states = latest.map(entry => entry.status?.state?.toLowerCase() ?? "unknown")
    const failures = latest.filter(entry => checkBucket(entry.status?.state ?? "") === "fail")
    const failing = failures.find(entry => !blockedPreview({ name: check.name, bucket: "fail", state: entry.status?.state ?? "unknown", deploymentState: entry.status?.state, description: entry.status?.description ?? undefined })) ?? failures[0]
    const state = failing?.status?.state?.toLowerCase() ?? (states.every(value => value === "success") ? "success" : states.find(value => checkBucket(value) === "unknown") ?? states.find(value => value !== "success")!)
    const description = failing?.status?.description?.trim() || (latest.length === 1 ? latest[0]?.status?.description?.trim() : undefined)
    const deploymentBucket = checkBucket(state)
    // Deployment evidence can hold a check back; it cannot turn an unsuccessful/skipped run into success.
    const bucket = check.bucket === "fail" || check.bucket === "cancel" || deploymentBucket === "pass" ? check.bucket : deploymentBucket
    return { ...check, bucket, state: bucket === check.bucket ? check.state : state, deploymentState: state, ...(description ? { description } : {}) }
  })
  for (const entry of evidence.filter((entry, index) => evidence.findIndex(other => other.deployment.creator?.login === entry.deployment.creator?.login && normalize(other.deployment.environment ?? "") === normalize(entry.deployment.environment ?? "")) === index)) {
    const host = provider(entry.deployment.creator?.login ?? "")
    if (!host) continue
    const environment = entry.deployment.environment ?? ""
    if (checks.some(check => provider(check.name) === host && (!project(check.name, host) || project(check.name, host) === normalize(environment) || project(check.name, host) === project(environment, "(?:preview|production)")))) continue
    const state = entry.status?.state ?? "unknown"
    mapped.push({ name: `${host} - ${environment}`, bucket: checkBucket(state), state, deploymentState: state, description: entry.status?.description ?? undefined })
  }
  return mapped
}

/** Only the two explicit readiness exceptions; neither is evidence of passing CI. */
export function readinessChecks(checks: readonly PrCheck[], base: readonly PrCheck[]): { checks: PrCheck[]; notes: string[] } {
  const notes: string[] = []
  const measured = checks.filter(check => {
    if (blockedPreview(check)) {
      notes.push(`${check.name}: preview not measured — deployment blocked. A hosting team member can authorise this GitHub author or redeploy.`)
      return false
    }
    if (check.bucket === "fail" && ["failure", "error"].includes(check.state.toLowerCase()) && base.some(prior => prior.name === check.name && prior.bucket === "fail" && ["failure", "error"].includes(prior.state.toLowerCase()))) {
      notes.push(`${check.name}: already failing before this pull request.`)
      return false
    }
    return true
  })
  return { checks: measured, notes }
}

/** Retry transient unreadable responses, without treating them as an empty inventory. */
export async function retryCheckRead<T>(read: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read() } catch (error) {
      if (attempt === 2) throw error
      await sleep(10_000)
    }
  }
}
