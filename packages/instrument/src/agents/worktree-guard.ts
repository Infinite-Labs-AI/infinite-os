// The reviewer reads a throwaway DETACHED worktree of the PR head (§3f.1, scout S2 §1.5): it holds only
// committed files, so no `.env*`, no `.vercel/.env*` and no `node_modules`. That closes "the reviewer
// quotes a secret into a public review" structurally. This guard refuses to start a reviewer anywhere
// else: the repo itself, a dir that is not a git worktree, or one holding an untracked `.env*` file.
import { lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"

import { git } from "./git-exec.js"

const SKIP = new Set([".git", "node_modules"])

export async function assertReviewWorktree(worktreeDir: string, repoRoot: string): Promise<void> {
  if (resolve(worktreeDir) === resolve(repoRoot)) throw new Error("the reviewer must read a detached worktree, never the repo itself")
  const dotGit = await lstat(join(worktreeDir, ".git")).catch(() => null)
  if (!dotGit || !dotGit.isFile()) throw new Error("the reviewer's folder is not a linked git worktree")
  const envFiles = await findEnvFiles(worktreeDir, "")
  if (envFiles.length === 0) return
  const tracked = await git(worktreeDir, ["ls-files", "-z", "--", ...envFiles])
  const trackedSet = new Set(tracked.stdout.toString("utf8").split("\0").filter(Boolean))
  const untracked = envFiles.filter((file) => !trackedSet.has(file))
  if (untracked.length > 0) throw new Error(`the review worktree holds an untracked env file (${untracked[0]}); refusing to start the reviewer`)
}

async function findEnvFiles(root: string, prefix: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(join(root, prefix))
  } catch {
    return []
  }
  const out: string[] = []
  for (const name of names) {
    if (SKIP.has(name)) continue
    const rel = prefix === "" ? name : `${prefix}/${name}`
    const info = await lstat(join(root, rel)).catch(() => null)
    if (!info) continue
    if (info.isDirectory()) out.push(...(await findEnvFiles(root, rel)))
    else if (name.startsWith(".env")) out.push(rel)
  }
  return out
}
