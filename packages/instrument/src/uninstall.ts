import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs"
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
import type { UninstallResult } from "./types.js"

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
  const runAdapter = manifest.providers.length > 0 || !manifest.serverLane
  const adapter = getFrameworkAdapter(manifest.framework)
  if (runAdapter && !adapter?.uninstall) {
    throw new Error(`No uninstall implementation is registered for ${manifest.framework}.`)
  }

  const snapshot = snapshotFiles(options.root, [
    ...manifest.files,
    ...(manifest.serverLane?.brief ? [manifest.serverLane.brief] : []),
    ...(manifest.serverLane?.guide ? [manifest.serverLane.guide] : []),
    installManifestRelativePath
  ])

  let frameworkResult: { removedFiles: string[]; restoredFiles: string[]; warnings: string[] }
  try {
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
    restoredFiles: [...frameworkResult.restoredFiles, ...harness.restoredFiles],
    warnings: [...frameworkResult.warnings, ...harness.warnings],
    manifestPath: hasWiringLeftover ? null : manifestPath
  }
}

function removeDirIfEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) {
    rmdirSync(path)
  }
}
