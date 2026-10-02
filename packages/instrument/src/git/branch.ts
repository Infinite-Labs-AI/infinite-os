// The PR branch (lane O4, §3g.1): which base it starts from, and creating it from `origin/<base>` before any
// scan or edit, so the plan, the census and the allowlist describe the tree the PR will change (wf4 PR-03).
import type { TagHosting } from "../wizard/contracts/bridge.js"
import type { GitHostAdapter } from "../wizard/contracts/git-host.js"
import type { BaseSource } from "../wizard/contracts/state.js"

export interface ResolvedBase {
  base: string
  baseSource: BaseSource
  /** True for the two fallbacks (`default_branch`, `origin_head`): the UI labels them "fallback". */
  fallback: boolean
  /** One status line, e.g. "Base: main (from Vercel)" or "Base: main (fallback: the repo's default branch)". */
  label: string
}

/** A branch name git accepts and that cannot be read as an option or a refspec. */
export function isSafeBranchName(name: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(name) &&
    !name.startsWith("-") &&
    !name.startsWith("/") &&
    !name.endsWith("/") &&
    !name.endsWith(".lock") &&
    !name.includes("..") &&
    !name.includes("//")
  )
}

/**
 * §3g.1 base order: Vercel's production branch, else `gh repo view --json defaultBranchRef`, else
 * `git symbolic-ref refs/remotes/origin/HEAD`. The last two are labelled "fallback".
 */
export async function resolveBase(input: {
  hosting: TagHosting | null
  host: Pick<GitHostAdapter, "repoFacts">
  originHead: () => Promise<string | null>
}): Promise<ResolvedBase | null> {
  const fromVercel = input.hosting?.provider === "vercel" ? input.hosting.vercel?.productionBranch ?? null : null
  if (fromVercel && isSafeBranchName(fromVercel)) {
    return { base: fromVercel, baseSource: "vercel", fallback: false, label: `Base: ${fromVercel} (Vercel's production branch)` }
  }
  // gh missing, logged out or offline is not a stop: the third source (origin/HEAD) still answers.
  const facts = await input.host.repoFacts().catch(() => null)
  const fromHost = facts === null || "unsupported" in facts ? null : facts.defaultBranch
  if (fromHost && isSafeBranchName(fromHost)) {
    return {
      base: fromHost,
      baseSource: "default_branch",
      fallback: true,
      label: `Base: ${fromHost} (fallback: the repo's default branch; Infinite could not read Vercel's production branch)`
    }
  }
  const fromOrigin = await input.originHead()
  if (fromOrigin && isSafeBranchName(fromOrigin)) {
    return {
      base: fromOrigin,
      baseSource: "origin_head",
      fallback: true,
      label: `Base: ${fromOrigin} (fallback: origin/HEAD; Infinite could not read Vercel's production branch)`
    }
  }
  return null
}

/** `refs/remotes/origin/main` or `origin/main` → `main`. */
export function originHeadToBranch(symbolicRef: string): string | null {
  const trimmed = symbolicRef.trim()
  const match = /^(?:refs\/remotes\/)?origin\/(.+)$/.exec(trimmed)
  return match ? match[1]! : null
}
