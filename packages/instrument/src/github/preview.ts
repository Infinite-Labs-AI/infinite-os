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
  environment_url?: string | null
  created_at?: string
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
  const ready: Array<{ deployment: RawDeployment; url: string }> = []
  for (const deployment of previews) {
    const statuses = await gh.json<RawDeploymentStatus[]>(["api", `repos/{owner}/{repo}/deployments/${deployment.id}/statuses?per_page=20`])
    const success = statuses.find((status) => status.state === "success" && isUsablePreviewUrl(status.environment_url))
    if (success && isUsablePreviewUrl(success.environment_url)) ready.push({ deployment, url: success.environment_url })
  }
  if (ready.length === 0) return null
  // One Vercel project: its preview. Several: only the linked project's, and only when exactly one matches.
  if (previews.length === 1) return ready[0]!.url
  if (projectName === null) return null
  const matched = ready.filter((candidate) => matchesProject(candidate.deployment, candidate.url, projectName))
  return matched.length === 1 ? matched[0]!.url : null
}
