import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

import { snapshotFiles, restoreSnapshot } from "./apply.js"
import { getFrameworkAdapter } from "./frameworks/index.js"
import { detectRepoStatus } from "./inspect.js"
import {
  installManifestPath,
  installManifestRelativePath,
  readInstallManifest
} from "./manifest.js"
import { readConversionsManifest, unmarkConversions } from "./harness/marking.js"
import { readHarnessOutputs, removeHarnessOutputs } from "./harness/outputs.js"
import { reverseServerLane } from "./server-lane/install.js"
import { reverseEditRecord } from "./install/edits.js"
import { writeFileAtomic } from "./frameworks/shared.js"
import type { InstallManifest, UninstallResult } from "./types.js"

export interface UninstallInstallationOptions {
  root: string
  allowDirty?: boolean
  dryRun?: boolean
}

/**
 * The harness half of uninstall: unmark every recorded conversion (`.infinite/conversions.json`),
 * then remove the harness's own outputs (`.infinite/harness.json`: REPORT.md, the proposal, the
 * brief, the `.gitignore` block). Both are hash-gated by their own modules; a dry run only lists.
 */
function reverseHarness(root: string, dryRun: boolean): { removedFiles: string[]; restoredFiles: string[]; warnings: string[] } {
  const removedFiles: string[] = []
  const restoredFiles: string[] = []
  const warnings: string[] = []
  const conversions = readConversionsManifest(root)
  const outputs = readHarnessOutputs(root)
  if (dryRun) {
    for (const file of new Set((conversions?.marked ?? []).map((entry) => entry.file))) restoredFiles.push(file)
    for (const file of outputs?.files ?? []) removedFiles.push(file)
    if (outputs?.gitignoreBlock) restoredFiles.push(".gitignore")
    return { removedFiles, restoredFiles, warnings }
  }
  if (conversions) {
    const undone = unmarkConversions(root)
    for (const file of new Set(undone.restored.map((entry) => entry.file))) restoredFiles.push(file)
    for (const skipped of undone.skipped) {
      warnings.push(`Conversion mark in ${skipped.file}:${skipped.line} left as is: ${skipped.reason}`)
    }
  }
  if (outputs) {
    const removed = removeHarnessOutputs(root)
    removedFiles.push(...removed.removedFiles)
    if (removed.gitignore === "removed") restoredFiles.push(".gitignore")
    if (removed.gitignore === "kept") warnings.push("The .gitignore block changed since the harness wrote it; left as is.")
  }
  return { removedFiles, restoredFiles, warnings }
}

export interface ReverseEditsResult {
  /** Files restored (or, for an edit that created the file, removed), newest record first. */
  reversed: string[]
  /** Files left as they are because they changed since the edit ("changed since; left as is"). */
  leftAsIs: string[]
  /** One founder-facing line per file left as is. */
  warnings: string[]
}

/**
 * §3e.6: reverse the receipt's `edits` NEWEST FIRST — they were made after the managed install, so
 * they come off before it. Each record is reversed only while its file still hashes to the record's
 * `afterHash`, by applying its exact `textEdits` in reverse (agent edits carry them too), and only when
 * the result hashes to `beforeHash`; otherwise the file is left exactly as it is, with a warning.
 * A dry run only reports what it would do.
 */
export function reverseRecordedEdits(root: string, manifest: Pick<InstallManifest, "edits">, dryRun: boolean): ReverseEditsResult {
  const reversed: string[] = []
  const leftAsIs: string[] = []
  const warnings: string[] = []
  const blocked = new Set<string>()
  const pending = new Map<string, string | null>()
  const read = (file: string): string | null => {
    if (pending.has(file)) return pending.get(file) ?? null
    const absolutePath = join(root, file)
    return existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
  }
  for (const record of [...(manifest.edits ?? [])].reverse()) {
    if (blocked.has(record.file)) continue
    const outcome = reverseEditRecord(read(record.file), record)
    if (!outcome.ok) {
      // An older record of the same file can only be reversed on top of this one: stop the chain.
      blocked.add(record.file)
      leftAsIs.push(record.file)
      warnings.push(
        outcome.reason === "missing"
          ? `${record.file}: recorded edit not reversed — the file is gone; left as is.`
          : `${record.file}: changed since infinite-tag edited it; left as is (review it by hand).`
      )
      continue
    }
    pending.set(record.file, outcome.content)
    if (!reversed.includes(record.file)) reversed.push(record.file)
  }
  if (!dryRun) {
    for (const [file, content] of pending) {
      const absolutePath = join(root, file)
      if (content === null) rmSync(absolutePath, { force: true })
      else writeFileAtomic(absolutePath, content)
    }
  }
  return { reversed, leftAsIs: [...new Set(leftAsIs)], warnings }
}

export function uninstallInstallation(options: UninstallInstallationOptions): UninstallResult {
  const manifest = readInstallManifest(options.root)
  const dryRun = options.dryRun ?? false
  if (!manifest) {
    // No managed install — but the harness may still have marks or outputs to take back
    // (a --plan run, or an all-adopted site).
    const harnessOnly = readConversionsManifest(options.root) !== null || readHarnessOutputs(options.root) !== null
    if (!harnessOnly) {
      return {
        removedFiles: [],
        restoredFiles: [],
        warnings: ["No .infinite/install.json manifest found. Nothing to uninstall."],
        manifestPath: null
      }
    }
    if (!dryRun && detectRepoStatus(options.root) === "dirty" && !options.allowDirty) {
      throw new Error("Refusing to uninstall on a dirty git tree without --allow-dirty.")
    }
    const harness = reverseHarness(options.root, dryRun)
    if (!dryRun) removeDirIfEmpty(join(options.root, ".infinite"))
    return { ...harness, manifestPath: null }
  }

  if (!dryRun && detectRepoStatus(options.root) === "dirty" && !options.allowDirty) {
    throw new Error("Refusing to uninstall on a dirty git tree without --allow-dirty.")
  }

  // A server-lane-only manifest (no providers) never ran the pixel adapter, so it has nothing
  // to reverse there; the lane's own reversal below is hash-gated per file.
  // An edits-only receipt (the wizard improved adopted tags and installed nothing) has no pixel wiring either.
  const runAdapter = manifest.providers.length > 0 || (!manifest.serverLane && (manifest.edits ?? []).length === 0)
  const adapter = getFrameworkAdapter(manifest.framework)
  if (runAdapter && !adapter?.uninstall) {
    throw new Error(`No uninstall implementation is registered for ${manifest.framework}.`)
  }

  const snapshot = snapshotFiles(options.root, [
    ...new Set([
      ...manifest.files,
      ...(manifest.serverLane?.brief ? [manifest.serverLane.brief] : []),
      ...(manifest.serverLane?.guide ? [manifest.serverLane.guide] : []),
      ...(manifest.edits ?? []).map((edit) => edit.file),
      installManifestRelativePath
    ])
  ])

  let frameworkResult: { removedFiles: string[]; restoredFiles: string[]; warnings: string[] }
  let edits: ReverseEditsResult
  try {
    // The wizard's recorded edits were made AFTER the managed install: they come off first.
    edits = reverseRecordedEdits(options.root, manifest, dryRun)
    frameworkResult =
      runAdapter && adapter?.uninstall
        ? adapter.uninstall({
            root: options.root,
            appRoot: manifest.appRoot,
            manifest,
            dryRun
          })
        : { removedFiles: [], restoredFiles: [], warnings: [] }
    const laneResult = reverseServerLane({ root: options.root, manifest, dryRun })
    frameworkResult = {
      removedFiles: [...frameworkResult.removedFiles, ...laneResult.removedFiles],
      restoredFiles: [...frameworkResult.restoredFiles, ...laneResult.restoredFiles],
      warnings: [...frameworkResult.warnings, ...laneResult.warnings]
    }
  } catch (error) {
    restoreSnapshot(options.root, snapshot)
    throw error
  }

  const hasWiringLeftover = frameworkResult.warnings.some((w) =>
    w.includes("automatically") || w.includes("leftover")
  )

  const manifestPath = installManifestPath(options.root)
  if (!dryRun && !hasWiringLeftover) {
    rmSync(manifestPath)
    removeDirIfEmpty(dirname(manifestPath))
    // Also prune empty lib dirs left by adapter file removals
    const appRoot = manifest.appRoot === "." ? options.root : join(options.root, manifest.appRoot)
    for (const candidate of ["lib", "src/lib"]) {
      removeDirIfEmpty(join(appRoot, candidate))
    }
    // Deepest first, and ONLY directories the lane itself created: a `netlify/` or `functions/`
    // directory the customer already had is their tree, not ours to remove.
    for (const candidate of manifest.serverLane?.createdDirs ?? []) {
      removeDirIfEmpty(join(options.root, candidate))
    }
  }

  // The harness's own writes come off after the managed install, and .infinite/ goes when empty.
  const harness = reverseHarness(options.root, dryRun)
  if (!dryRun) removeDirIfEmpty(join(options.root, ".infinite"))

  return {
    removedFiles: [
      ...(hasWiringLeftover ? frameworkResult.removedFiles : [...frameworkResult.removedFiles, installManifestRelativePath]),
      ...harness.removedFiles
    ],
    restoredFiles: [...new Set([...edits.reversed, ...frameworkResult.restoredFiles, ...harness.restoredFiles])],
    warnings: [...edits.warnings, ...frameworkResult.warnings, ...harness.warnings],
    manifestPath: hasWiringLeftover ? null : manifestPath,
    ...((manifest.edits ?? []).length > 0 ? { editsReversed: edits.reversed, editsLeftAsIs: edits.leftAsIs } : {})
  }
}

function removeDirIfEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) {
    rmdirSync(path)
  }
}
