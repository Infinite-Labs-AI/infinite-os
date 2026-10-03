// Who is logged in to gh, and what the repo allows (lane O4, §3g.2). No email or org field is ever read.
import type { GhClient } from "./gh.js"

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
  /** ADMIN / MAINTAIN / WRITE can push; READ / TRIAGE cannot (stop; never fork). */
  viewerPermission: string | null
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
  return {
    nameWithOwner,
    owner,
    name,
    // Unknown privacy is treated as PUBLIC: IDs not in the diff are then redacted (the safe side).
    isPrivate: raw.isPrivate === true,
    defaultBranch: raw.defaultBranchRef?.name ?? null,
    viewerPermission: raw.viewerPermission ?? null,
    homepageUrl: typeof raw.homepageUrl === "string" && raw.homepageUrl.length > 0 ? raw.homepageUrl : null
  }
}

export function canPush(viewerPermission: string | null): boolean {
  return viewerPermission === "ADMIN" || viewerPermission === "MAINTAIN" || viewerPermission === "WRITE"
}
