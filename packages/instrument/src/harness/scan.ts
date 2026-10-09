// The bounded source walk shared by provider detection (inspect.ts) and conversion proposal
// (marking.ts). Same rules as the tag's repo-wide provider scan — its skip lists are imported,
// not copied: source extensions only, skip dependency/build/VCS/static/test directories and
// vendor/declaration/test files, 2,000 files, 512 KB per file, never follow symlinks.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { providerScanSkippedDirectories, providerScanSkippedFiles } from "../provider-scan-rules.js"

export const SCAN_EXTENSIONS = /\.(html|htm|tsx|jsx|ts|js|mjs|cjs|astro|vue|svelte)$/
/**
 * The skip lists are shared with the tag's provider scan so provider detection and conversion proposal can
 * never disagree with the installer's scan; the harness only adds its own `.infinite/` output dir.
 */
export const SCAN_SKIPPED_FILES = providerScanSkippedFiles
export const SCAN_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([...providerScanSkippedDirectories, ".infinite"])
export const SCAN_MAX_FILES = 2_000
export const SCAN_MAX_FILE_BYTES = 512 * 1024

/** App-root-relative source files in sorted, deterministic walk order. */
export function walkSourceFiles(appRoot: string): string[] {
  return scanSourceFiles(appRoot).files
}

export interface SourceScanOptions {
  /**
   * Also walk `public/` (static sites serve their pages from it). Off by default: for a framework app
   * `public/` holds assets, and the provider walk has always skipped it.
   */
  includePublic?: boolean
  /** Default SCAN_MAX_FILES. */
  maxFiles?: number
}

export interface SourceScan {
  /** App-root-relative, sorted, deterministic. Scoped to the app root it was given. */
  files: string[]
  /** True when the walk stopped at the cap with files left unread. */
  truncated: boolean
  /** The founder-facing warning when truncated (null otherwise). */
  warning: string | null
}

/** The truncation warning: the scan is a sample, so "not found" in it is never proof of absence. */
export function scanTruncationWarning(maxFiles: number): string {
  return `The source scan stopped at ${maxFiles.toLocaleString("en-US")} files, so some files were not read. Anything the scan did not find may still exist; narrow the app root (--app-root) to scan it fully.`
}

/**
 * The bounded walk with a truncation report. Scoped to `appRoot` (the caller passes the APP root,
 * never the repo root of a monorepo), symlinks never followed, the same skip lists as the provider
 * scan. It reads one file past the cap only to know that the cap cut the walk short.
 */
export function scanSourceFiles(appRoot: string, options: SourceScanOptions = {}): SourceScan {
  const maxFiles = options.maxFiles ?? SCAN_MAX_FILES
  const skipped = options.includePublic
    ? new Set([...SCAN_SKIPPED_DIRECTORIES].filter((name) => name !== "public"))
    : SCAN_SKIPPED_DIRECTORIES
  const files: string[] = []
  let truncated = false
  const visit = (directory: string): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(join(appRoot, directory), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (truncated) return
      const relativePath = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!skipped.has(entry.name)) visit(relativePath)
        continue
      }
      if (!entry.isFile() || !SCAN_EXTENSIONS.test(entry.name) || SCAN_SKIPPED_FILES.test(entry.name)) continue
      try {
        if (statSync(join(appRoot, relativePath)).size > SCAN_MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      files.push(relativePath)
    }
  }
  visit("")
  return { files, truncated, warning: truncated ? scanTruncationWarning(maxFiles) : null }
}

/** Contents or null (unreadable files are skipped, never fatal). */
export function readSourceFile(appRoot: string, relativePath: string): string | null {
  try {
    return readFileSync(join(appRoot, relativePath), "utf8")
  } catch {
    return null
  }
}

/** 1-based line number of a character offset. */
export function lineNumberAt(contents: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < contents.length; index += 1) {
    if (contents.charCodeAt(index) === 10) line += 1
  }
  return line
}

/** Splits keeping the file's own newline convention out of the lines. */
export function splitLines(contents: string): string[] {
  return contents.split("\n")
}
