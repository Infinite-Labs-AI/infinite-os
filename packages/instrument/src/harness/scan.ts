// The bounded source walk shared by provider detection (inspect.ts) and conversion proposal
// (marking.ts). Same rules as the tag's repo-wide provider scan — its skip lists are imported,
// not copied: source extensions only, skip dependency/build/VCS/static/test directories and
// vendor/declaration/test files, 2,000 files, 512 KB per file, never follow symlinks.
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

import { providerScanSkippedDirectories, providerScanSkippedFiles } from "../inspect.js"

export const SCAN_EXTENSIONS = /\.(html|htm|tsx|jsx|ts|js|mjs|cjs|astro|vue|svelte)$/
/**
 * The skip lists are the tag's own (inspect.ts) so provider detection and conversion proposal can
 * never disagree with the installer's scan; the harness only adds its own `.infinite/` output dir.
 */
export const SCAN_SKIPPED_FILES = providerScanSkippedFiles
export const SCAN_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([...providerScanSkippedDirectories, ".infinite"])
export const SCAN_MAX_FILES = 2_000
export const SCAN_MAX_FILE_BYTES = 512 * 1024

/** App-root-relative source files in sorted, deterministic walk order. */
export function walkSourceFiles(appRoot: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    if (files.length >= SCAN_MAX_FILES) return
    let entries
    try {
      entries = readdirSync(join(appRoot, directory), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= SCAN_MAX_FILES) return
      const relativePath = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!SCAN_SKIPPED_DIRECTORIES.has(entry.name)) visit(relativePath)
        continue
      }
      if (!entry.isFile() || !SCAN_EXTENSIONS.test(entry.name) || SCAN_SKIPPED_FILES.test(entry.name)) continue
      try {
        if (statSync(join(appRoot, relativePath)).size > SCAN_MAX_FILE_BYTES) continue
      } catch {
        continue
      }
      files.push(relativePath)
    }
  }
  visit("")
  return files
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
