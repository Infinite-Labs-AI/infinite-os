// §3y.4: the production deploy signal from GitHub Deployments, for a site Infinite has no Vercel connection for.
// Vercel's GitHub integration writes a deployment per commit: `environment:"Production"` (a monorepo:
// `Production – <project>`), and — checked live on the smoke repo — `production_environment:false`, so the
// environment NAME is what marks production. Read-only `gh api` calls; never a guess: an ambiguous monorepo is
// `not_found`.
import type { GhClient } from "./gh.js"
import { matchesProject, type RawDeployment, type RawDeploymentStatus } from "./preview.js"

export interface RawProductionDeployment extends RawDeployment {
  sha?: string
  production_environment?: boolean
}

export type GhDeployState = "ready" | "failed" | "building" | "not_found"

/** Production iff `production_environment` OR the environment name starts with "Production". */
export function isProductionDeployment(deployment: RawProductionDeployment): boolean {
  return deployment.production_environment === true || (typeof deployment.environment === "string" && /^production\b/i.test(deployment.environment))
}

/**
 * A deployment's state from its statuses (GitHub lists them newest first). A later `inactive` (a newer deployment
 * superseded it) never hides the success before it; `failure`/`error` → failed; `queued`/`pending`/`in_progress` →
 * building; no status → not_found.
 */
export function deploymentState(statuses: readonly RawDeploymentStatus[]): GhDeployState {
  const meaningful = statuses.filter((status) => status.state !== "inactive")
  if (meaningful.length === 0) return statuses.length > 0 ? "ready" : "not_found"
  const newest = meaningful[0]!.state
  if (newest === "success") return "ready"
  if (newest === "failure" || newest === "error") return "failed"
  if (newest === "queued" || newest === "pending" || newest === "in_progress") return "building"
  return "not_found"
}

/** The production deployments among `rows`, narrowed to `projectName` when several projects deploy; null = ambiguous. */
function pickProduction(rows: readonly RawProductionDeployment[], projectName: string | null): RawProductionDeployment[] | null {
  const production = rows.filter(isProductionDeployment)
  const environments = new Set(production.map((row) => (row.environment ?? "").toLowerCase()))
  if (environments.size <= 1) return production
  if (projectName === null) return null
  const matched = production.filter((row) => matchesProject(row, null, projectName))
  return matched.length > 0 && new Set(matched.map((row) => row.environment)).size === 1 ? matched : null
}

async function statusesOf(gh: GhClient, id: number): Promise<RawDeploymentStatus[]> {
  return gh.json<RawDeploymentStatus[]>(["api", `repos/{owner}/{repo}/deployments/${id}/statuses?per_page=20`])
}

/** The merge SHA's production deployment, as GitHub shows it. */
export async function productionDeploymentForSha(gh: GhClient, sha: string, projectName: string | null): Promise<{ state: GhDeployState }> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("productionDeploymentForSha needs a full SHA")
  const rows = await gh.json<RawProductionDeployment[]>(["api", `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=20`])
  const production = pickProduction(rows, projectName)
  if (production === null || production.length === 0) return { state: "not_found" }
  // Several attempts for one SHA (a redeploy): the newest deployment speaks.
  const newest = [...production].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0]!
  return { state: deploymentState(await statusesOf(gh, newest.id)) }
}

/** The newest SUCCESSFUL production deployment (its SHA and time), or null. */
export async function latestProductionDeployment(gh: GhClient, projectName: string | null): Promise<{ sha: string; createdAt: string } | null> {
  const environments = ["Production", ...(projectName ? [`Production – ${projectName}`] : [])]
  const rows: RawProductionDeployment[] = []
  for (const environment of environments) {
    rows.push(...(await gh.json<RawProductionDeployment[]>(["api", `repos/{owner}/{repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=5`])))
  }
  const production = pickProduction(rows, projectName)
  if (production === null) return null
  const newestFirst = [...production].sort((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))
  for (const row of newestFirst) {
    if (!row.sha || !/^[0-9a-f]{40}$/.test(row.sha)) continue
    if (deploymentState(await statusesOf(gh, row.id)) === "ready") return { sha: row.sha, createdAt: row.created_at ?? "" }
  }
  return null
}

/** True when the repo has at least one deployment created by `vercel[bot]` (the preview / production signal). */
export async function vercelDeploymentSeen(gh: GhClient): Promise<boolean> {
  const rows = await gh.json<RawProductionDeployment[]>(["api", "repos/{owner}/{repo}/deployments?per_page=10"])
  return rows.some((row) => row.creator?.login === "vercel[bot]")
}
