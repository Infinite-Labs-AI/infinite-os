import { createHash } from "node:crypto"
import { GITIGNORE_FENCE_BLOCK } from "../harness/outputs.js"
import { wizardGitExtras } from "../git/index.js"
import type { WizardDeps } from "./contracts/deps.js"

/** Restore only the exact fence append/create performed after `before`, never owner edits. */
export async function restoreUninstalledFence(root: string, deps: Pick<WizardDeps, "fs" | "git">): Promise<boolean> {
  if (!("showFile" in deps.git)) return false
  const git = wizardGitExtras(deps.git)
  if (!git) return false
  const original = await git.showFile("HEAD", ".gitignore")
  const path = `${root}/.gitignore`
  const current = await deps.fs.readText(path)
  if (current === original) return true
  const separator = original && !original.endsWith("\n") ? "\n" : ""
  const expected = `${original ?? ""}${separator}${GITIGNORE_FENCE_BLOCK}\n`
  if (current !== expected) return false
  if (original !== null) {
    await deps.fs.writeTextAtomic(path, original)
    return true
  }
  return deps.fs.removeFile?.(path, `sha256:${createHash("sha256").update(current).digest("hex")}`) ?? false
}
