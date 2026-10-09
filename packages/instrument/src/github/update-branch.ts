import { git as readGit } from "../agents/git-exec.js"
import type { WizardGitOps } from "../git/index.js"

/** Only the requested merge and commits from its verified base parent are an approved integration. */
export async function branchUpdateCommits(root: string, git: Pick<WizardGitOps, "isAncestor">, previous: string, merged: string, base: string): Promise<string[] | null> {
  if (![previous, merged, base].every(sha => /^[a-f0-9]{40}$/.test(sha))) return null
  if (previous === merged) return []
  const entry = await readGit(root, ["rev-list", "--parents", "-n", "1", merged])
  if (entry.code !== 0) return null
  const [sha, first, second, extra] = entry.stdout.toString("utf8").trim().split(" ")
  if (sha !== merged || first !== previous || !second || extra || !await git.isAncestor(second, base)) return null
  const commits = await readGit(root, ["rev-list", `${previous}..${merged}`])
  if (commits.code !== 0) return null
  const rows = commits.stdout.toString("utf8").trim().split("\n").filter(Boolean)
  return rows.every(value => /^[a-f0-9]{40}$/.test(value)) ? rows : null
}
