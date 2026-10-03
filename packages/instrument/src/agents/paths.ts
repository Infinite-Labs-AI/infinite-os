// Where the agent runner keeps its scratch, and which paths an agent must never read (§3a.9 item 2,
// §3f.3 SENSITIVE_DENIES, §3f.7 scratch rule).
//
// Token-bearing scratch (`tag.mcp.json`, schemas next to the Codex `-o` file) and the fence snapshots
// live under `$HOME/Library/Caches/infinite-tag/…` (0700 dirs, 0600 files): never under `/tmp`,
// `/private/tmp` or `$TMPDIR`, which stay READABLE under the Codex confinement profile (L7), and never in
// the repo. `$HOME` is denied to Codex; Claude runs `--restricted` (cwd only) plus explicit denies.
import type { Dirent } from "node:fs"
import { constants } from "node:fs"
import { access, lstat, mkdir, readdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { WIZARD_TOKEN_SCRATCH_HOME_RELATIVE } from "../wizard/contracts/agents.js"

export interface SensitivePath {
  /** Absolute, normalised; the realpath when the path exists. */
  path: string
  kind: "dir" | "file"
}

/** `<home>/Library/Caches/infinite-tag`. */
export function wizardCacheRoot(home: string): string {
  return join(home, WIZARD_TOKEN_SCRATCH_HOME_RELATIVE)
}

/** `<cache>/<runId>`: the run's token-bearing scratch (tag.mcp.json, schemas, Codex `-o` files). */
export function runScratchDir(home: string, runId: string): string {
  return join(wizardCacheRoot(home), safeSegment(runId))
}

/** `<cache>/snapshots/<runId>/<turn>`: one fence snapshot (§3f.6). */
export function snapshotDir(home: string, runId: string, turn: string | number): string {
  return join(wizardCacheRoot(home), "snapshots", safeSegment(runId), safeSegment(String(turn)))
}

function safeSegment(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9._-]/g, "_")
  if (clean === "" || clean === "." || clean === "..") throw new Error(`unsafe path segment: ${value}`)
  return clean
}

/** mkdir -p with 0700 on every directory it creates or finds under `base` (the cache root). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
}

/**
 * Resolves `path` to an absolute normalised path, following symlinks where the path (or its nearest
 * existing ancestor) exists, so a deny written for it matches what the agent's tools resolve to (L3b:
 * Claude matches denies after tilde, `/tmp`→`/private/tmp` and symlink resolution).
 */
export async function resolveRealpath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch {
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return join(await resolveRealpath(parent), basename(absolute))
  }
}

async function kindOf(path: string, fallback: "dir" | "file"): Promise<"dir" | "file"> {
  try {
    return (await stat(path)).isDirectory() ? "dir" : "file"
  } catch {
    return fallback
  }
}

async function listPrefixed(dir: string, prefix: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names.filter((name) => name.startsWith(prefix)).map((name) => join(dir, name))
  } catch {
    return []
  }
}

/**
 * Every sensitive path for this user, resolved (§3f.3): `GROWTH_OS_HOME` and every `~/.growth-os*`,
 * `~/Library/Application Support/Infinite*`, `~/.codex`, the Claude config dirs' credentials files,
 * `~/.ssh`, `~/.aws`, `~/.npmrc`, `~/.netrc`, and the wizard's own cache (snapshots + scratch).
 * Fixed entries are listed even when absent (a deny on a missing path is harmless); globbed ones only
 * when they exist. Deduplicated by resolved path, in a stable order.
 */
export async function resolveSensitivePaths(input: {
  home: string
  env: Readonly<Record<string, string | undefined>>
}): Promise<SensitivePath[]> {
  const home = input.home
  const candidates: Array<{ path: string; fallback: "dir" | "file" }> = []
  const growthHome = input.env.GROWTH_OS_HOME?.trim()
  if (growthHome) candidates.push({ path: growthHome, fallback: "dir" })
  for (const path of await listPrefixed(home, ".growth-os")) candidates.push({ path, fallback: "dir" })
  for (const path of await listPrefixed(join(home, "Library", "Application Support"), "Infinite")) {
    candidates.push({ path, fallback: "dir" })
  }
  candidates.push({ path: join(home, ".codex"), fallback: "dir" })
  const claudeDirs = new Set<string>(await listPrefixed(home, ".claude"))
  const configured = input.env.CLAUDE_CONFIG_DIR?.trim()
  if (configured) claudeDirs.add(resolve(configured))
  claudeDirs.add(join(home, ".claude"))
  for (const dir of [...claudeDirs].sort()) {
    const credentials = join(dir, ".credentials.json")
    if (dir === join(home, ".claude") || (await exists(credentials))) candidates.push({ path: credentials, fallback: "file" })
  }
  for (const name of [".ssh", ".aws"]) candidates.push({ path: join(home, name), fallback: "dir" })
  for (const name of [".npmrc", ".netrc"]) candidates.push({ path: join(home, name), fallback: "file" })
  candidates.push({ path: wizardCacheRoot(home), fallback: "dir" })

  const out: SensitivePath[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const path = await resolveRealpath(candidate.path)
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ path, kind: await kindOf(path, candidate.fallback) })
  }
  return out
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Every executable `name` on PATH, in PATH order (wrappers kept: never realpath'd). */
export async function whichAll(name: string, pathEnv: string | undefined): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  for (const dir of (pathEnv ?? "").split(":")) {
    if (dir === "") continue
    const candidate = join(dir, name)
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      const info = await stat(candidate)
      if (!info.isFile()) continue
      await access(candidate, constants.X_OK)
      out.push(candidate)
    } catch {
      // not here
    }
  }
  return out
}

/** Dirs a repo-secret walk never enters (build output, dependencies, git itself). */
const SECRET_WALK_SKIP = new Set(["node_modules", ".next", "dist", "build", "out", ".git", ".infinite", ".turbo", ".vercel", "coverage"])

/**
 * §3z.12 §3f.3 (B20): the repo secrets the Codex profile also denies — the realpaths of every existing
 * `<root>/**\/.env*` (bounded walk; build and dependency dirs skipped), `<root>/.npmrc` and `<root>/.netrc`
 * (`"none"`), and for the worker `<root>/.git` (read only). Claude roles deny the same by `--disallowedTools`.
 */
export async function repoSecretPaths(root: string, options: { maxDepth?: number; maxEntries?: number } = {}): Promise<{ none: string[]; readOnly: string[] }> {
  const maxDepth = options.maxDepth ?? 8
  let budget = options.maxEntries ?? 20_000
  const none: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || budget <= 0) return
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      budget -= 1
      if (budget <= 0) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SECRET_WALK_SKIP.has(entry.name)) await walk(path, depth + 1)
      } else if (entry.name.startsWith(".env")) {
        none.push(await resolveRealpath(path))
      }
    }
  }
  await walk(root, 0)
  for (const name of [".npmrc", ".netrc"]) {
    if (await exists(join(root, name))) none.push(await resolveRealpath(join(root, name)))
  }
  const gitDir = join(root, ".git")
  const readOnly = (await exists(gitDir)) ? [await resolveRealpath(gitDir)] : []
  return { none: [...new Set(none)].sort(), readOnly }
}

/** Where the jobs step keeps the final tree seal of a run (outside the repo and $TMPDIR; B5/B29). */
export function finalSealPath(home: string, runId: string): string {
  return join(wizardCacheRoot(home), "snapshots", safeSegment(runId), "final.seal.json")
}
