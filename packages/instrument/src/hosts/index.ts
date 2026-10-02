// Which git host the repo uses, and the adapter for it (§3g.2). The remote is parsed WITHOUT its credentials:
// userinfo, query and fragment are dropped, so a token in a remote URL never reaches a link, a label or a log.
import type { GitHostAdapter } from "../wizard/contracts/git-host.js"
import type { GitHostKind } from "../wizard/contracts/state.js"
import type { WizardGitOps } from "../git/index.js"
import type { GhClient } from "../github/gh.js"
import { bitbucketNewPrUrl, createBitbucketAdapter } from "./bitbucket.js"
import { createGitHubAdapter } from "./github.js"
import { createGitLabAdapter } from "./gitlab.js"
import { createOtherAdapter } from "./other.js"

export interface ParsedRemote {
  /** Lowercased host, no port, no userinfo. */
  host: string
  /** `owner/repo` (GitLab: `group/subgroup/repo`), no `.git`. */
  path: string
  owner: string
  repo: string
  /** `host/path`: the normalised form, safe to show and to send. */
  label: string
}

/** `git@host:a/b.git`, `ssh://git@host:22/a/b`, `https://user:token@host/a/b.git?x#y` → host + path. */
export function parseRemote(remoteUrl: string): ParsedRemote | null {
  const raw = remoteUrl.trim()
  if (!raw || /[\s\0]/.test(raw)) return null
  let host: string
  let path: string
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(raw)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return null
    }
    host = url.hostname
    path = url.pathname
  } else if (scp) {
    host = scp[1]!
    path = scp[2]!
  } else {
    return null
  }
  host = host.toLowerCase().replace(/\.$/, "")
  path = path.replace(/[?#].*$/, "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "")
  const segments = path.split("/").filter(Boolean)
  if (!host || segments.length < 2 || segments.some((segment) => segment === "." || segment === "..")) return null
  const repo = segments[segments.length - 1]!
  const owner = segments.slice(0, -1).join("/")
  return { host, path: segments.join("/"), owner, repo, label: `${host}/${segments.join("/")}` }
}

export function detectHostKind(remote: ParsedRemote | null): GitHostKind {
  if (!remote) return "other"
  if (remote.host === "github.com") return "github"
  if (remote.host === "gitlab.com" || remote.host.startsWith("gitlab.")) return "gitlab"
  if (remote.host === "bitbucket.org") return "bitbucket"
  return "other"
}

/**
 * The link the wizard prints when it cannot open the PR itself (§3g.2): GitHub's compare page, GitLab's new
 * merge request, Bitbucket's new pull request. Null for an unknown host (the branch name is printed instead).
 */
export function hostLinkFor(kind: GitHostKind, remote: ParsedRemote | null, base: string, branch: string): string | null {
  if (!remote) return null
  const enc = encodeURIComponent
  switch (kind) {
    case "github":
      return `https://github.com/${remote.path}/compare/${enc(base)}...${enc(branch)}?expand=1`
    case "gitlab":
      return `https://${remote.host}/${remote.path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(branch)}&merge_request%5Btarget_branch%5D=${enc(base)}`
    case "bitbucket":
      return bitbucketNewPrUrl(remote.owner, remote.repo, branch)
    default:
      return null
  }
}

export function createGitHostAdapter(input: { remoteUrl: string | null; gh: GhClient; git: WizardGitOps }): GitHostAdapter {
  const kind = detectHostKind(input.remoteUrl ? parseRemote(input.remoteUrl) : null)
  switch (kind) {
    case "github":
      return createGitHubAdapter(input.gh)
    case "gitlab":
      return createGitLabAdapter(input.git)
    case "bitbucket":
      return createBitbucketAdapter()
    default:
      return createOtherAdapter()
  }
}
