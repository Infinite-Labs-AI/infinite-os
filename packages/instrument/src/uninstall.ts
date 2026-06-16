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
import type { UninstallResult } from "./types.js"

export interface UninstallInstallationOptions {
  root: string
  allowDirty?: boolean
  dryRun?: boolean
}

export function uninstallInstallation(options: UninstallInstallationOptions): UninstallResult {
  const manifest = readInstallManifest(options.root)
  if (!manifest) {
    return {
      removedFiles: [],
      restoredFiles: [],
      warnings: ["No .infinite/install.json manifest found. Nothing to uninstall."],
      manifestPath: null
    }
  }

  const dryRun = options.dryRun ?? false
  if (!dryRun && detectRepoStatus(options.root) === "dirty" && !options.allowDirty) {
    throw new Error("Refusing to uninstall on a dirty git tree without --allow-dirty.")
  }

  const adapter = getFrameworkAdapter(manifest.framework)
  if (!adapter?.uninstall) {
    throw new Error(`No uninstall implementation is registered for ${manifest.framework}.`)
  }

  const snapshot = snapshotFiles(options.root, [
    ...manifest.files,
    installManifestRelativePath
  ])

  let frameworkResult: ReturnType<NonNullable<typeof adapter.uninstall>>
  try {
    frameworkResult = adapter.uninstall({
      root: options.root,
      appRoot: manifest.appRoot,
      manifest,
      dryRun
    })
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
  }

  return {
    removedFiles: hasWiringLeftover
      ? frameworkResult.removedFiles
      : [...frameworkResult.removedFiles, installManifestRelativePath],
    restoredFiles: frameworkResult.restoredFiles,
    warnings: frameworkResult.warnings,
    manifestPath: hasWiringLeftover ? null : manifestPath
  }
}

function removeDirIfEmpty(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) {
    rmdirSync(path)
  }
}
