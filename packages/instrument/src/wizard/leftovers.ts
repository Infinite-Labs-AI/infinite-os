// §3y.8 (P2-4, P3-11): the wizard's OWN leftover edits from a run that was set aside, and the clean-tree rule.
//
// A failed run leaves its edits uncommitted on its branch. `--fresh` used to refuse on them ("Commit or stash your
// changes first (app/layout.tsx)") — the wizard's own work. A dirty path is a LEFTOVER only when the set-aside run's
// receipt (`.infinite/install.json`) holds an edit record for it whose `afterHash` equals the file's bytes NOW (so a
// later hand edit is never taken for the wizard's), plus a `.gitignore` whose change is the wizard's fence alone.
// Discarding writes HEAD's bytes back to exactly those files (a file the run created is deleted only while its hash
// still matches): never `git restore --worktree`, never `git reset`.
import { dirname, join } from "node:path"

import { wizardCacheRoot } from "../agents/paths.js"

import { INSTALL_MANIFEST_PATH } from "../git/commit.js"
import type { WizardGitOps } from "../git/index.js"
import { gitignoreChangeIsFenceOnly } from "../git/status.js"
import { sha256Tagged } from "../install/edits.js"
import type { WizardFs } from "./contracts/deps.js"

/** `.gitignore` and the wizard's own `.infinite/` are exempt from the clean-tree check (`ios:…/harness/run.ts:197`). */
export const CLEAN_TREE_EXEMPT = (path: string): boolean => path === ".gitignore" || path === ".infinite" || path.startsWith(".infinite/")

/** The dirty paths that make the tree "not clean" for the wizard. */
export function blockingDirtyPaths(dirtyPaths: readonly string[]): string[] {
  return dirtyPaths.filter((path) => !CLEAN_TREE_EXEMPT(path))
}

/** The refusal line for a dirty tree, naming at most five paths. */
export function dirtyTreeMessage(paths: readonly string[]): string {
  const shown = paths.slice(0, 5).join(", ")
  return `Commit or stash your changes first (${shown}${paths.length > 5 ? `, +${paths.length - 5} more` : ""}); the wizard works on its own branch.`
}

export interface Leftover {
  path: string
  /** The run created the file (its first record has no `beforeHash`). */
  created: boolean
  afterHash: string
}

export interface LeftoverScan {
  /** The set-aside run's own unfinished edits (each still byte-identical to what the run wrote). */
  leftovers: Leftover[]
  /** Every other blocking dirty path (never touched by the wizard). */
  others: string[]
  /** `.gitignore` differs from HEAD by the wizard's fence alone. */
  gitignoreFence: boolean
}

interface ReceiptEdit {
  file?: unknown
  runId?: unknown
  afterHash?: unknown
  beforeHash?: unknown
}

async function receiptEdits(fs: Pick<WizardFs, "readText">, root: string): Promise<ReceiptEdit[]> {
  const text = await fs.readText(join(root, INSTALL_MANIFEST_PATH))
  if (text === null) return []
  try {
    const edits = (JSON.parse(text) as { edits?: unknown }).edits
    return Array.isArray(edits) ? (edits as ReceiptEdit[]) : []
  } catch {
    return []
  }
}

/** Which dirty paths are the set-aside run's own unfinished edits. */
export async function findLeftovers(root: string, fs: Pick<WizardFs, "readText">, git: Pick<WizardGitOps, "cleanTree" | "showFile">, runId: string | null): Promise<LeftoverScan> {
  const tree = await git.cleanTree()
  const blocking = blockingDirtyPaths(tree.dirtyPaths)
  const edits = runId ? (await receiptEdits(fs, root)).filter((edit) => edit.runId === runId && typeof edit.file === "string") : []
  const leftovers: Leftover[] = []
  const others: string[] = []
  for (const path of blocking) {
    const records = edits.filter((edit) => edit.file === path)
    const last = records[records.length - 1]
    const current = await fs.readText(join(root, path))
    if (!last || typeof last.afterHash !== "string" || current === null || sha256Tagged(current) !== last.afterHash) {
      others.push(path)
      continue
    }
    leftovers.push({ path, created: records[0]!.beforeHash === null, afterHash: last.afterHash })
  }
  const gitignoreDirty = tree.dirtyPaths.includes(".gitignore")
  const gitignoreFence = gitignoreDirty && gitignoreChangeIsFenceOnly(await git.showFile("HEAD", ".gitignore"), await fs.readText(join(root, ".gitignore")))
  return { leftovers, others, gitignoreFence }
}

/** The command a user runs to discard the leftovers by hand (the exit-2 line when the wizard is not told to). */
export function discardCommand(scan: LeftoverScan, base: string): string {
  const restore = scan.leftovers.filter((entry) => !entry.created).map((entry) => entry.path)
  const remove = scan.leftovers.filter((entry) => entry.created).map((entry) => entry.path)
  const parts = [
    ...(restore.length > 0 || scan.gitignoreFence ? [`git restore --source=HEAD --staged --worktree -- ${[...restore, ...(scan.gitignoreFence ? [".gitignore"] : [])].join(" ")}`] : []),
    ...(remove.length > 0 ? [`rm ${remove.join(" ")}`] : []),
    `git switch ${base}`
  ]
  return parts.join(" && ")
}

/**
 * Puts HEAD's bytes back on exactly the leftovers (and a fence-only `.gitignore`), deletes a created file only while
 * its hash still matches, unstages them, and drops the set-aside run's records from the working receipt.
 */
export async function discardLeftovers(root: string, fs: WizardFs, git: WizardGitOps, scan: LeftoverScan, runId: string): Promise<void> {
  const paths = [...scan.leftovers.map((entry) => entry.path), ...(scan.gitignoreFence ? [".gitignore"] : [])]
  await git.unstage(paths).catch(() => undefined)
  for (const entry of scan.leftovers) {
    if (entry.created) {
      if (fs.removeFile) await fs.removeFile(join(root, entry.path), entry.afterHash)
      continue
    }
    const head = await git.showFile("HEAD", entry.path)
    if (head !== null) await fs.writeTextAtomic(join(root, entry.path), head, 0o644)
  }
  if (scan.gitignoreFence) {
    const head = await git.showFile("HEAD", ".gitignore")
    const current = await fs.readText(join(root, ".gitignore"))
    if (head !== null) await fs.writeTextAtomic(join(root, ".gitignore"), head, 0o644)
    else if (current !== null && fs.removeFile) await fs.removeFile(join(root, ".gitignore"), sha256Tagged(current))
  }
  const receiptPath = join(root, INSTALL_MANIFEST_PATH)
  const text = await fs.readText(receiptPath)
  if (text !== null) {
    try {
      const receipt = JSON.parse(text) as { edits?: ReceiptEdit[] }
      if (Array.isArray(receipt.edits)) {
        const kept = receipt.edits.filter((edit) => edit.runId !== runId)
        if (kept.length !== receipt.edits.length) {
          const next = { ...receipt, ...(kept.length > 0 ? { edits: kept } : {}) }
          if (kept.length === 0) delete (next as { edits?: unknown }).edits
          await fs.writeTextAtomic(receiptPath, `${JSON.stringify(next, null, 2)}\n`, 0o644)
        }
      }
    } catch {
      // A receipt that is not JSON is left for the receipt reset (it is set aside on the new run's branch).
    }
  }
}

/**
 * §3y.8 (P2-5): right after `before` creates the run's branch (never on a resume), a working `.infinite/install.json`
 * that differs from the base's committed one holds another run's never-merged records. It is moved to
 * `~/Library/Caches/infinite-tag/<runId>/install.json.before-reset` (0600) and replaced by the base's copy (or
 * none). Returns where it was kept, or null when nothing was set aside.
 */
export async function resetStaleReceipt(input: {
  root: string
  fs: WizardFs
  git: Pick<WizardGitOps, "showFile">
  baseSha: string
  runId: string
  home: string
}): Promise<string | null> {
  const path = join(input.root, INSTALL_MANIFEST_PATH)
  const working = await input.fs.readText(path)
  if (working === null) return null
  const base = await input.git.showFile(input.baseSha, INSTALL_MANIFEST_PATH)
  if (working === base) return null
  const kept = join(wizardCacheRoot(input.home), input.runId, "install.json.before-reset")
  await input.fs.mkdirp(dirname(kept), 0o700)
  await input.fs.writeTextAtomic(kept, working, 0o600)
  if (base !== null) await input.fs.writeTextAtomic(path, base, 0o644)
  else if (input.fs.removeFile) await input.fs.removeFile(path, sha256Tagged(working))
  return kept
}
