// Who is logged in to gh, and what the repo allows (lane O4, §3g.2). No email or org field is ever read.
import { GhError, type GhClient } from "./gh.js"

/**
 * `gh auth status --hostname github.com --json hosts` always exits 0 with `--json`, so the state is parsed,
 * never the exit code (S2 §5).
 */
export async function ghAuthStatus(gh: GhClient, hostname = "github.com"): Promise<{ ok: boolean; login: string | null }> {
  let parsed: { hosts?: Record<string, Array<{ state?: string; active?: boolean; login?: string }>> }
  try {
    parsed = await gh.json(["auth", "status", "--hostname", hostname, "--json", "hosts"])
  } catch {
    return { ok: false, login: null }
  }
  const accounts = parsed.hosts?.[hostname] ?? []
  const active = accounts.find((account) => account.active !== false && account.state === "success") ?? null
  if (!active || typeof active.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(active.login)) return { ok: false, login: null }
  return { ok: true, login: active.login }
}

export interface GhRepoFacts {
  nameWithOwner: string
  owner: string
  name: string
  isPrivate: boolean
  defaultBranch: string | null
  /** ADMIN / MAINTAIN / WRITE can push; READ / TRIAGE need an approved fork when the repo allows one. */
  viewerPermission: string | null
  allowForking: boolean | null
  /** §3y.1: the repo's homepage (a host hint for the live-site ask only; never an answer). */
  homepageUrl: string | null
}

export async function ghRepoFacts(gh: GhClient): Promise<GhRepoFacts> {
  const raw = await gh.json<{
    nameWithOwner?: string
    isPrivate?: boolean
    defaultBranchRef?: { name?: string } | null
    viewerPermission?: string | null
    homepageUrl?: string | null
  }>(["repo", "view", "--json", "nameWithOwner,isPrivate,defaultBranchRef,viewerPermission,homepageUrl"])
  const nameWithOwner = typeof raw.nameWithOwner === "string" ? raw.nameWithOwner : ""
  const [owner = "", name = ""] = nameWithOwner.split("/")
  if (!owner || !name) throw new Error("gh repo view returned no nameWithOwner")
  const settings = await gh.json<{ allow_forking?: boolean }>(["api", "repos/{owner}/{repo}"]).catch(() => null)
  return {
    nameWithOwner,
    owner,
    name,
    // Unknown privacy is treated as PUBLIC: IDs not in the diff are then redacted (the safe side).
    isPrivate: raw.isPrivate === true,
    defaultBranch: raw.defaultBranchRef?.name ?? null,
    viewerPermission: raw.viewerPermission ?? null,
    allowForking: typeof settings?.allow_forking === "boolean" ? settings.allow_forking : null,
    homepageUrl: typeof raw.homepageUrl === "string" && raw.homepageUrl.length > 0 ? raw.homepageUrl : null
  }
}

/** GitHub returns the fork's owner and clone URLs; reject an unexpected destination before any push. */
export async function createViewerFork(gh: GhClient, repo: GhRepoFacts, preferSsh: boolean): Promise<{ remoteUrl: string; headOwner: string }> {
  const auth = await ghAuthStatus(gh)
  if (!auth.ok || !auth.login) throw new Error("GitHub is not signed in")
  type ForkResponse = { owner?: { login?: string }; name?: string; clone_url?: string; ssh_url?: string; parent?: { full_name?: string } | null }
  let existing: ForkResponse | null = null
  try {
    existing = await gh.json<ForkResponse>(["api", `repos/${auth.login}/${repo.name}`])
  } catch (error) {
    if (!(error instanceof GhError) || error.kind !== "not_found") throw error
  }
  if (existing && existing.parent?.full_name?.toLowerCase() !== repo.nameWithOwner.toLowerCase()) throw new Error("A repository with this name exists in your account, but it is not a fork of the target")
  const raw = existing ?? await gh.json<ForkResponse>(["api", "-X", "POST", "repos/{owner}/{repo}/forks"])
  const headOwner = raw.owner?.login ?? ""
  const name = raw.name ?? ""
  if (!/^[A-Za-z0-9-]{1,39}$/.test(headOwner) || name.toLowerCase() !== repo.name.toLowerCase()) throw new Error("GitHub returned an unexpected fork owner or repository")
  const remoteUrl = preferSsh ? raw.ssh_url : raw.clone_url
  const expected = preferSsh ? `git@github.com:${headOwner}/${name}.git` : `https://github.com/${headOwner}/${name}.git`
  if (remoteUrl !== expected) throw new Error("GitHub returned an unexpected fork remote")
  return { remoteUrl, headOwner }
}

export function canPush(viewerPermission: string | null): boolean {
  return viewerPermission === "ADMIN" || viewerPermission === "MAINTAIN" || viewerPermission === "WRITE"
}
