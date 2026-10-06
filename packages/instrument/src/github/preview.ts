// The PR head's Vercel preview URL (lane O4, §3g.2): from GitHub DEPLOYMENTS, not commit statuses (the
// `Vercel` status links the dashboard, not the preview; S2 fact 14). Keep only deployments created by
// `vercel[bot]` whose environment starts with `Preview`, then the first `success` status's
// `environment_url`. A monorepo with several Vercel projects has one Preview deployment per project: pick
// the one whose environment or URL names the linked project; when that cannot be told, none (never a guess).
import type { GhClient } from "./gh.js"

export interface RawDeployment {
  id: number
  environment?: string
  creator?: { login?: string } | null
  created_at?: string
}

export interface RawDeploymentStatus {
  state?: string
  description?: string | null
  environment_url?: string | null
  created_at?: string
}

export interface PreviewFailure { reason: string; blocked: boolean }

/** A terminal failure of this SHA's Vercel preview, including the dashboard's blocked-deployment reason. */
export async function previewFailureForSha(gh: GhClient, sha: string, projectName: string | null): Promise<PreviewFailure | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("previewFailureForSha needs a full SHA")
  const deployments = await gh.json<RawDeployment[]>(["api", `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=20`])
  const previews = deployments.filter(isVercelPreviewDeployment)
  const attempts: Array<{ deployment: RawDeployment; latest: RawDeploymentStatus | undefined; index: number }> = []
  for (const [index, deployment] of previews.entries()) {
    const statuses = await gh.json<RawDeploymentStatus[]>(["api", `repos/{owner}/{repo}/deployments/${deployment.id}/statuses?per_page=20`])
    attempts.push({ deployment, latest: statuses.find((status) => status.state !== "inactive"), index })
  }
  const candidates = attempts.length === 1 ? attempts : projectName
    ? attempts.filter(({ deployment, latest }) => matchesProject(deployment, latest?.environment_url ?? null, projectName))
    : []
  const newest = [...candidates].sort((a, b) => (Date.parse(b.deployment.created_at ?? "") || 0) - (Date.parse(a.deployment.created_at ?? "") || 0) || a.index - b.index)[0]
  if (newest) {
    const latest = newest.latest
    if (latest && ["failure", "error", "cancelled", "canceled"].includes(latest.state ?? "")) {
    const reason = latest.description?.trim() || "Vercel preview deployment failed"
    return { reason, blocked: /\bblocked\b/i.test(reason) }
    }
  }
  // A commit status can fail before GitHub publishes a deployment row.
  if (previews.length === 0) {
    const combined = await gh.json<{ statuses?: Array<{ context?: string; state?: string; description?: string | null }> }>(["api", `repos/{owner}/{repo}/commits/${sha}/status`]).catch(() => null)
    const failed = combined?.statuses?.find((status) => /^vercel(?:\b|:)/i.test(status.context ?? "") && ["failure", "error"].includes(status.state ?? ""))
    if (failed) {
      const reason = failed.description?.trim() || "Vercel preview deployment failed"
      return { reason, blocked: /\bblocked\b/i.test(reason) }
    }
  }
  return null
}

export function isVercelPreviewDeployment(deployment: RawDeployment): boolean {
  return deployment.creator?.login === "vercel[bot]" && typeof deployment.environment === "string" && deployment.environment.startsWith("Preview")
}

function slugOf(projectName: string): string {
  return projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
}

/** Whether a Preview deployment (or its URL) belongs to the named Vercel project. */
export function matchesProject(deployment: RawDeployment, url: string | null, projectName: string): boolean {
  const slug = slugOf(projectName)
  const environment = (deployment.environment ?? "").toLowerCase()
  // Vercel names a multi-project environment "Preview – <project>".
  if (environment.endsWith(` ${slug}`) || environment.endsWith(`– ${slug}`) || environment.endsWith(`- ${slug}`)) return true
  if (url) {
    try {
      const host = new URL(url).hostname.toLowerCase()
      return host.startsWith(`${slug}-`) || host === `${slug}.vercel.app`
    } catch {
      return false
    }
  }
  return false
}

/** A preview URL must be https on a host (never a path, never http). */
export function isUsablePreviewUrl(url: unknown): url is string {
  if (typeof url !== "string") return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" && parsed.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * The preview URL for `sha`, or null (not ready yet, none, or several projects that cannot be told apart).
 * `projectName` = the linked Vercel project (from the hosting verb), used only to pick among several.
 */
export async function previewUrlForSha(gh: GhClient, sha: string, projectName: string | null): Promise<string | null> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("previewUrlForSha needs a full SHA")
  const deployments = await gh.json<RawDeployment[]>(["api", `repos/{owner}/{repo}/deployments?sha=${sha}&per_page=20`])
  const previews = deployments.filter(isVercelPreviewDeployment)
  const attempts: Array<{ deployment: RawDeployment; latest: RawDeploymentStatus | undefined; index: number }> = []
  for (const [index, deployment] of previews.entries()) {
    const statuses = await gh.json<RawDeploymentStatus[]>(["api", `repos/{owner}/{repo}/deployments/${deployment.id}/statuses?per_page=20`])
    attempts.push({ deployment, latest: statuses.find((status) => status.state !== "inactive"), index })
  }
  // Multiple projects need the linked project; among retries of that project only the newest speaks.
  const candidates = previews.length === 1 ? attempts : projectName === null ? [] : attempts.filter(({ deployment, latest }) => matchesProject(deployment, latest?.environment_url ?? null, projectName))
  const newest = [...candidates].sort((a, b) => (Date.parse(b.deployment.created_at ?? "") || 0) - (Date.parse(a.deployment.created_at ?? "") || 0) || a.index - b.index)[0]
  return newest?.latest?.state === "success" && isUsablePreviewUrl(newest.latest.environment_url) ? newest.latest.environment_url : null
}
