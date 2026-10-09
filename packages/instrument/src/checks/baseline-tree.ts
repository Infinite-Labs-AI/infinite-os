import { constants } from "node:fs"
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, symlink, unlink } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { GitOps, WizardGitOps } from "../wizard/contracts/git-host.js"

export class BaselineUnavailableError extends Error {}

type BaselineGit = Pick<GitOps, "worktreeAddDetached" | "worktreeRemove"> & Partial<Pick<WizardGitOps, "head" | "cleanTree" | "worktreeList" | "isIgnored" | "ownsBaselineWorktree">>

/** Sweep only our marked worktrees for this repository, and only after their owning process died. */
export async function sweepBaselineTrees(root: string, git: BaselineGit): Promise<void> {
  if (!git.worktreeList || !git.ownsBaselineWorktree) return
  const repo = await realpath(root)
  for (const dir of await git.worktreeList()) {
    if (!git.ownsBaselineWorktree(dir, repo)) continue
    const marker = `${dir}.baseline.json`
    const info = await lstat(marker).catch(() => null)
    if (!info?.isFile()) continue
    let owner: { schema?: string; root?: string; pid?: number } | null
    try { owner = JSON.parse(await readFile(marker, "utf8")) as typeof owner }
    catch { continue } // Malformed/unrelated ownership is never permission to remove a worktree.
    if (!owner || owner.schema !== "infinite-tag.baseline.v2" || owner.root !== repo || !Number.isSafeInteger(owner.pid) || owner.pid! < 1) continue
    try { process.kill(owner.pid!, 0); continue } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue }
    // A valid dead-owner marker establishes responsibility: cleanup failures must be visible.
    await git.worktreeRemove(dir)
  }
}

const inside = (path: string, root: string) => {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Both a lexical checkout path and its canonical path can occur in a tracked absolute symlink. */
function repositoryRelative(path: string, roots: readonly string[]): string | null {
  for (const root of roots) if (inside(path, root)) return relative(root, path)
  return null
}

/** Walk physical directories only; resolve every link separately, never recurse through it. */
async function symlinksIn(path: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) out.push(child)
    else if (entry.isDirectory()) out.push(...await symlinksIn(child))
  }
  return out
}

/** Preserve the BASE's tracked link graph, while rebasing absolute references to this checkout. */
async function isolateTrackedLinks(tree: string, roots: readonly string[]): Promise<void> {
  for (const link of await symlinksIn(tree)) {
    const raw = await readlink(link)
    if (isAbsolute(raw)) {
      const rel = repositoryRelative(raw, roots)
      if (rel !== null) {
        await unlink(link)
        await symlink(relative(dirname(link), join(tree, rel)) || ".", link)
        continue
      }
    }
    if (!inside(resolve(dirname(link), raw), tree)) throw new BaselineUnavailableError(`Cannot isolate the base build: tracked link ${relative(tree, link)} leaves the detached source tree.`)
  }
}

/** Check the eventual target as well as every immediate link, before environment links are added. */
async function validateIsolatedLinks(tree: string): Promise<void> {
  for (const link of await symlinksIn(tree)) {
    let target: string
    try { target = await realpath(link) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && relative(tree, link).split(sep).includes("node_modules") && inside(resolve(dirname(link), await readlink(link)), tree)) continue
      throw new BaselineUnavailableError(`Cannot isolate the base build: link ${relative(tree, link)} is dangling, cyclic or unreadable.`)
    }
    if (!inside(target, tree)) throw new BaselineUnavailableError(`Cannot isolate the base build: link ${relative(tree, link)} resolves outside the detached source tree.`)
  }
}

/** Clone dependency topology, rebase every in-repo link, and preserve tracked base files. */
async function cloneDependencies(source: string, destination: string, root: string, tree: string, roots: readonly string[]): Promise<void> {
  const info = await lstat(source)
  const existing = await lstat(destination).catch(() => null)
  if (info.isDirectory()) {
    if (existing && !existing.isDirectory()) throw new BaselineUnavailableError(`Cannot isolate the base build at ${relative(tree, destination)}.`)
    await mkdir(destination, { recursive: true })
    for (const entry of await readdir(source)) await cloneDependencies(join(source, entry), join(destination, entry), root, tree, roots)
  } else if (!existing) {
    await mkdir(dirname(destination), { recursive: true })
    if (info.isSymbolicLink()) {
      const target = resolve(dirname(source), await readlink(source))
      const rel = repositoryRelative(target, roots)
      if (rel === null) throw new BaselineUnavailableError(`Cannot isolate external dependency link ${relative(root, source)}.`)
      await symlink(relative(dirname(destination), join(tree, rel)) || ".", destination)
    } else if (info.isFile()) {
      // APFS clones are cheap; unlike hardlinks, a build cannot rewrite the live dependency's inode.
      await copyFile(source, destination, constants.COPYFILE_FICLONE)
    } else throw new BaselineUnavailableError(`Cannot isolate special dependency file ${relative(root, source)}.`)
  }
}

/** Build the recorded base, even after this run committed edits. Reuse installed dependencies only. */
export async function baselineTree(root: string, appRoot: string, sha: string, git: BaselineGit): Promise<{ root: string; dispose(): Promise<void> }> {
  await sweepBaselineTrees(root, git)
  if (git.head && git.cleanTree && await git.head() === sha) {
    const status = await git.cleanTree()
    if (status.dirtyPaths.every(path => path.startsWith(".infinite/"))) return { root, dispose: async () => {} }
  }
  const tree = await git.worktreeAddDetached(sha, "baseline")
  try {
    const roots = [...new Set([resolve(root), await realpath(root)])]
    const appRelative = repositoryRelative(resolve(root, appRoot), roots)
    if (appRelative === null) throw new BaselineUnavailableError("Cannot isolate an app root outside this repository.")
    const repo = await realpath(root)
    const isolated = await realpath(tree.dir)
    await isolateTrackedLinks(isolated, roots)
    const bases = [...new Set([repo, resolve(repo, appRelative)])]
    const dependencyRoots = bases.flatMap(base => [join(base, "node_modules"), join(base, ".yarn")])
    const present: string[] = []
    for (const source of dependencyRoots) {
      const info = await lstat(source).catch(() => null)
      if (!info) continue
      // A whole installation redirected elsewhere needs an independently installed base; its source
      // topology cannot safely be inferred from the current repository's workspace layout.
      if (info.isSymbolicLink()) throw new BaselineUnavailableError(`Cannot isolate the base build from linked ${relative(root, source)}.`)
      present.push(source)
    }
    for (const source of present) {
      const destination = join(isolated, relative(repo, source))
      // Physical topology keeps Turbopack inside the detached root and isolates every cache write.
      await cloneDependencies(source, destination, repo, isolated, roots)
    }
    // PnP resolves workspace paths from __dirname: symlinking these would select the edited source.
    for (const base of bases) for (const name of [".pnp.cjs", ".pnp.loader.mjs"]) {
      const source = join(base, name)
      if (await lstat(source).catch(() => null)) await cloneDependencies(source, join(isolated, relative(repo, source)), repo, isolated, roots)
    }
    await validateIsolatedLinks(isolated)
    for (const base of bases) for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!name.startsWith(".env")) continue
      const source = join(base, name)
      const destination = join(isolated, relative(repo, source))
      const info = await lstat(source).catch(() => null)
      if (!info || (!info.isFile() && !info.isSymbolicLink()) || await lstat(destination).catch(() => null)) continue
      if (git.isIgnored && !await git.isIgnored(relative(repo, source))) continue
      await mkdir(dirname(destination), { recursive: true })
      // Only a read-only link is exposed; the sandbox never permits writes to either environment path.
      await symlink(source, destination)
    }
    return { root: tree.dir, dispose: () => git.worktreeRemove(tree.dir) }
  } catch (error) {
    await git.worktreeRemove(tree.dir)
    throw error
  }
}
