import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { GitOps } from "../wizard/contracts/git-host.js"

export class BaselineUnavailableError extends Error {}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Inspect real directories only: no external linked source is silently used as base evidence. */
async function hasWorkspaceLinks(path: string, root: string, dependencyRoots: string[]): Promise<boolean> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path))
    if (!inside(target, root)) throw new BaselineUnavailableError(`Cannot isolate the base build: an installed dependency links outside this repository (${relative(root, path)}).`)
    return !dependencyRoots.some(base => inside(target, base))
  }
  if (!info.isDirectory()) return false
  let workspace = false
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) workspace = await hasWorkspaceLinks(join(path, entry.name), root, dependencyRoots) || workspace
  }
  return workspace
}

/** Clone dependency topology, rebase every in-repo link, and preserve tracked base files. */
async function cloneDependencies(source: string, destination: string, root: string, tree: string): Promise<void> {
  const info = await lstat(source)
  const existing = await lstat(destination).catch(() => null)
  if (info.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new BaselineUnavailableError(`Cannot isolate the base build at ${relative(tree, destination)}.`)
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source)) await cloneDependencies(join(source, entry), join(destination, entry), root, tree)
  } else if (!existing) {
    await mkdir(dirname(destination), { recursive: true })
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(source), await readlink(source))
      if (!inside(target, root)) throw new BaselineUnavailableError(`Cannot isolate external dependency link ${relative(root, source)}.`)
      await symlink(relative(dirname(destination), join(tree, relative(root, target))), destination)
    } else if (info.isFile()) {
      // APFS clones are cheap; unlike hardlinks, a build cannot rewrite the live dependency's inode.
      await copyFile(source, destination, constants.COPYFILE_FICLONE)
    } else throw new BaselineUnavailableError(`Cannot isolate special dependency file ${relative(root, source)}.`)
  }
}

/** Build the recorded base, even after this run committed edits. Reuse installed dependencies only. */
export async function baselineTree(root: string, appRoot: string, sha: string, git: Pick<GitOps, "worktreeAddDetached" | "worktreeRemove">): Promise<{ root: string; dispose(): Promise<void> }> {
  const tree = await git.worktreeAddDetached(sha)
  try {
    const bases = [...new Set([root, resolve(root, appRoot)])]
    const dependencyRoots = bases.flatMap(base => [join(base, "node_modules"), join(base, ".yarn")])
    const present: string[] = []
    let workspaceLinks = false
    for (const source of dependencyRoots) {
      const info = await lstat(source).catch(() => null)
      if (!info) continue
      // A whole installation redirected elsewhere needs an independently installed base; its source
      // topology cannot safely be inferred from the current repository's workspace layout.
      if (info.isSymbolicLink()) throw new BaselineUnavailableError(`Cannot isolate the base build from linked ${relative(root, source)}.`)
      present.push(source)
      workspaceLinks = await hasWorkspaceLinks(source, root, dependencyRoots) || workspaceLinks
    }
    for (const source of present) {
      const destination = join(tree.dir, relative(root, source))
      const existing = await lstat(destination).catch(() => null)
      if (!workspaceLinks && !existing) {
        await mkdir(dirname(destination), { recursive: true })
        await symlink(source, destination)
      } else await cloneDependencies(source, destination, root, tree.dir)
    }
    // PnP resolves workspace paths from __dirname: symlinking these would select the edited source.
    for (const base of bases) for (const name of [".pnp.cjs", ".pnp.loader.mjs"]) {
      const source = join(base, name)
      if (await lstat(source).catch(() => null)) await cloneDependencies(source, join(tree.dir, relative(root, source)), root, tree.dir)
    }
    return { root: tree.dir, dispose: () => git.worktreeRemove(tree.dir) }
  } catch (error) {
    await git.worktreeRemove(tree.dir)
    throw error
  }
}
