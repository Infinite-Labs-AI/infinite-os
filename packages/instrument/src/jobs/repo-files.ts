// The read-only repo snapshot the job detectors run over (lane O8).
//
// Detectors are PURE functions of a snapshot, so `seedCandidates` is deterministic for the same input
// and every detector is tested against in-memory fixtures. The loader reuses the tag's own bounded
// source walk (`harness/scan.ts`: source extensions only, the installer's skip lists, 2,000 files,
// 512 KB per file, never following symlinks) and adds the handful of non-source files the jobs need:
// host config (`vercel.json`, `netlify.toml`, `_headers`, `_redirects`), package manifests (monorepo
// layout + dependencies) and Markdown and template page content.
//
// Every path in a snapshot is REPO-ROOT relative and POSIX (`apps/web/app/layout.tsx`), so allowlists
// are monorepo-safe (§3e.2). The snapshot never holds `.env*` files: nothing here reads them.
import { lstatSync, readFileSync, readdirSync } from "node:fs"
import { join, posix } from "node:path"

import { SCAN_MAX_FILE_BYTES, SCAN_MAX_FILES, SCAN_SKIPPED_DIRECTORIES, walkSourceFiles } from "../harness/scan.js"

export interface PackageManifestFacts {
  /** Repo-relative directory of the package.json ("." for the repo root). */
  dir: string
  name: string | null
  /** dependencies ∪ devDependencies names, sorted. */
  deps: string[]
  /** `workspaces` globs (array or `{packages}` form), as written. */
  workspaces: string[]
  /** `scripts.build`, when present. */
  buildScript: string | null
}

export interface RepoSnapshot {
  /** Repo-relative app root, "." for a single-app repo. */
  appRoot: string
  /** Repo-root-relative POSIX path → text, in sorted path order. */
  files: ReadonlyMap<string, string>
  packages: PackageManifestFacts[]
  /** True when the bounded walk hit its cap (the scan is incomplete). */
  truncated: boolean
}

const HOST_CONFIG_FILES = [
  "vercel.json",
  "netlify.toml",
  "_headers",
  "_redirects",
  "public/_headers",
  "public/_redirects",
  "static/_headers",
  "static/_redirects",
  "pnpm-workspace.yaml"
] as const

const PAGE_CONTENT = /\.(?:mdx?|liquid|php|ejs|njk)$/i
const MARKDOWN_ROOTS = ["app", "pages", "src", "content", "docs", "legal", "components", "templates", "views", "public", "static"] as const
const MARKDOWN_MAX_FILES = 200
const WORKSPACE_PACKAGE_PARENTS = ["apps", "packages", "sites", "web"] as const

/** Joins an app-root-relative path onto the repo-relative app root. */
export function repoPath(appRoot: string, appRelativePath: string): string {
  return appRoot === "." || appRoot === "" ? appRelativePath : posix.join(appRoot, appRelativePath)
}

/** A regular file only: `lstat`, so a symbolic link (to anywhere, inside the repo or not) is never read. */
function readSmallFile(absolutePath: string): string | null {
  try {
    const stats = lstatSync(absolutePath)
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > SCAN_MAX_FILE_BYTES) return null
    return readFileSync(absolutePath, "utf8")
  } catch {
    return null
  }
}

function listDirectories(absolutePath: string): string[] {
  try {
    return readdirSync(absolutePath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !SCAN_SKIPPED_DIRECTORIES.has(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function walkPageContent(appRootAbsolute: string): string[] {
  const found: string[] = []
  const visit = (relative: string): void => {
    if (found.length >= MARKDOWN_MAX_FILES) return
    let entries
    try {
      entries = readdirSync(join(appRootAbsolute, relative), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (found.length >= MARKDOWN_MAX_FILES) return
      const child = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue
      if (entry.isDirectory()) {
        if (!SCAN_SKIPPED_DIRECTORIES.has(entry.name)) visit(child)
      } else if (entry.isFile() && PAGE_CONTENT.test(child)) {
        found.push(child)
      }
    }
  }
  for (const entry of readdirSync(appRootAbsolute, { withFileTypes: true })) {
    if (entry.isFile() && !entry.name.startsWith(".") && PAGE_CONTENT.test(entry.name) && found.length < MARKDOWN_MAX_FILES) found.push(entry.name)
  }
  for (const rootDir of MARKDOWN_ROOTS) visit(rootDir)
  return found
}

/** Parses one package.json's text into the facts the detectors use (null when it is not JSON). */
export function packageFactsFrom(dir: string, text: string): PackageManifestFacts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const depNames = new Set<string>()
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = record[key]
    if (deps && typeof deps === "object" && !Array.isArray(deps)) for (const name of Object.keys(deps)) depNames.add(name)
  }
  const rawWorkspaces = record.workspaces
  const workspaces = Array.isArray(rawWorkspaces)
    ? rawWorkspaces.filter((value): value is string => typeof value === "string")
    : rawWorkspaces && typeof rawWorkspaces === "object" && Array.isArray((rawWorkspaces as { packages?: unknown }).packages)
      ? ((rawWorkspaces as { packages: unknown[] }).packages.filter((value): value is string => typeof value === "string"))
      : []
  const scripts = record.scripts
  const build = scripts && typeof scripts === "object" ? (scripts as Record<string, unknown>).build : undefined
  return {
    dir,
    name: typeof record.name === "string" ? record.name : null,
    deps: [...depNames].sort(),
    workspaces,
    buildScript: typeof build === "string" ? build : null
  }
}

/**
 * Builds a snapshot from in-memory files (tests and callers that already hold the text). Package
 * manifests are read from the `package.json` entries; the map is re-sorted by path.
 */
export function snapshotFromFiles(files: Readonly<Record<string, string>>, options: { appRoot?: string; truncated?: boolean } = {}): RepoSnapshot {
  const sorted = new Map<string, string>()
  for (const path of Object.keys(files).sort()) sorted.set(path, files[path]!)
  const packages: PackageManifestFacts[] = []
  for (const [path, text] of sorted) {
    if (path !== "package.json" && !path.endsWith("/package.json")) continue
    const dir = path === "package.json" ? "." : path.slice(0, -"/package.json".length)
    const facts = packageFactsFrom(dir, text)
    if (facts) packages.push(facts)
  }
  return { appRoot: options.appRoot ?? ".", files: sorted, packages, truncated: options.truncated ?? false }
}

/**
 * Reads the repo (bounded, read-only). `root` is absolute; `appRoot` is repo-relative ("." for a
 * single-app repo). `package.json` files are recorded as package facts and kept in `files` too.
 */
export function loadRepoSnapshot(root: string, appRoot: string): RepoSnapshot {
  const normalizedAppRoot = appRoot === "" ? "." : appRoot
  const appRootAbsolute = normalizedAppRoot === "." ? root : join(root, normalizedAppRoot)
  const files: Record<string, string> = {}

  const sourceFiles = walkSourceFiles(appRootAbsolute)
  for (const relative of sourceFiles) {
    const text = readSmallFile(join(appRootAbsolute, relative))
    if (text !== null) files[repoPath(normalizedAppRoot, relative)] = text
  }
  for (const relative of HOST_CONFIG_FILES) {
    for (const base of normalizedAppRoot === "." ? ["."] : [normalizedAppRoot, "."]) {
      const path = repoPath(base, relative)
      if (files[path] !== undefined) continue
      const text = readSmallFile(join(root, path))
      if (text !== null) files[path] = text
    }
  }
  const pageContent = walkPageContent(appRootAbsolute)
  for (const relative of pageContent) {
    const text = readSmallFile(join(appRootAbsolute, relative))
    if (text !== null) files[repoPath(normalizedAppRoot, relative)] = text
  }
  // Package manifests: the repo root, the app root, and the first level of the usual workspace parents.
  const manifestDirs = new Set<string>([".", normalizedAppRoot])
  for (const parent of WORKSPACE_PACKAGE_PARENTS) {
    for (const child of listDirectories(join(root, parent))) manifestDirs.add(`${parent}/${child}`)
  }
  for (const dir of [...manifestDirs].sort()) {
    const path = repoPath(dir, "package.json")
    const text = readSmallFile(join(root, path))
    if (text !== null) files[path] = text
  }
  return snapshotFromFiles(files, { appRoot: normalizedAppRoot, truncated: sourceFiles.length >= SCAN_MAX_FILES || pageContent.length >= MARKDOWN_MAX_FILES })
}
