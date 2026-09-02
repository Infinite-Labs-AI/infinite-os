import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

import { writeFileAtomic } from "./frameworks/shared.js"
import { getFrameworkAdapter } from "./frameworks/index.js"
import {
  computeContentHashes,
  installManifestPath,
  installManifestRelativePath,
  readInstallManifest,
  writeInstallManifestIfChanged
} from "./manifest.js"
import { applyServerLane } from "./server-lane/install.js"
import type {
  ApplyResult,
  InstallManifest,
  InstallPlan,
  ProviderId,
  SupportedFramework
} from "./types.js"
import { providerLabels } from "./types.js"

const minimumApplyConfidence = 0.75

export interface ApplyInstallationOptions {
  root: string
  workspaceId: string
  plan: InstallPlan
  allowDirty?: boolean
}

export function applyInstallation(options: ApplyInstallationOptions): ApplyResult {
  if (options.plan.blockers.length > 0) {
    throw new Error(
      `Refusing to apply an unsupported or blocked plan: ${options.plan.blockers.join(" ")}`
    )
  }

  if (options.plan.confidence < minimumApplyConfidence) {
    throw new Error(
      `Refusing to apply a low-confidence plan (${options.plan.confidence.toFixed(2)}).`
    )
  }

  if (options.plan.repoStatus === "dirty" && !options.allowDirty) {
    throw new Error("Refusing to apply on a dirty git tree without --allow-dirty.")
  }

  if (options.plan.applyMode !== "supported") {
    throw new Error(
      `Refusing to apply a plan-only framework (${options.plan.framework}). Review the plan instructions and wire it manually for now.`
    )
  }

  // Every requested provider already exists (adopted) and no server lane was asked for: there is
  // nothing to write, so nothing is written — no empty managed block, no manifest.
  if (options.plan.providers.length === 0 && !options.plan.serverLane) {
    return {
      changedFiles: [],
      manifestPath: installManifestPath(options.root),
      warnings: [nothingToInstallMessage(options.plan)]
    }
  }

  // A server-lane-only plan (no provider artifacts) skips the pixel adapter entirely.
  const runAdapter = options.plan.providers.length > 0 || !options.plan.serverLane
  const frameworkAdapter = getFrameworkAdapter(options.plan.framework)
  if (runAdapter && !frameworkAdapter?.apply) {
    throw new Error(`No apply implementation is registered for ${options.plan.framework}.`)
  }

  const snapshot = snapshotFiles(options.root, [
    ...options.plan.files,
    ...(options.plan.serverLane ? [options.plan.serverLane.briefPath] : []),
    installManifestRelativePath
  ])

  try {
    const previousManifest = readInstallManifest(options.root)
    const frameworkResult =
      runAdapter && frameworkAdapter?.apply
        ? frameworkAdapter.apply({
            root: options.root,
            appRoot: options.plan.appRoot,
            plan: options.plan,
            previousManifest
          })
        : { changedFiles: [], warnings: [], configOwnership: {} }

    const serverLaneResult = options.plan.serverLane
      ? applyServerLane({
          root: options.root,
          appRoot: options.plan.appRoot,
          framework: options.plan.framework,
          plan: options.plan.serverLane,
          artifacts: options.plan.artifacts,
          previousManifest
        })
      : null

    const configOwnership = {
      ...(frameworkResult.configOwnership ?? {}),
      ...(serverLaneResult?.configOwnership ?? {})
    }
    const requiresManual = frameworkResult.requiresManual ?? []
    const manifest: InstallManifest = {
      workspaceId: options.workspaceId,
      appRoot: options.plan.appRoot,
      framework: options.plan.framework as SupportedFramework,
      providers: options.plan.providers as ProviderId[],
      files: options.plan.files,
      envKeys: options.plan.envKeys,
      contentHashes: computeContentHashes(options.root, options.plan.files),
      ...(Object.keys(configOwnership).length > 0 ? { configOwnership } : {}),
      ...(serverLaneResult ? { serverLane: serverLaneResult.manifest } : {}),
      // The `requires_manual_snippet` state: recorded WITH the snippet so verify can later confirm the
      // wiring is actually present on disk (satisfied) instead of replaying a stale requirement.
      ...(requiresManual.length > 0 ? { requiresManual } : {}),
      wiringVersion: 1,
      verifiedAt: null
    }

    const manifestWrite = writeInstallManifestIfChanged(options.root, manifest)
    const changedFiles = [...frameworkResult.changedFiles, ...(serverLaneResult?.changedFiles ?? [])]
    if (manifestWrite.changed) {
      changedFiles.push(relative(options.root, manifestWrite.manifestPath) || ".infinite/install.json")
    }

    return {
      changedFiles,
      manifestPath: manifestWrite.manifestPath,
      warnings: [...frameworkResult.warnings, ...(serverLaneResult?.warnings ?? [])],
      ...(requiresManual.length > 0 ? { requiresManual } : {}),
      ...(serverLaneResult
        ? {
            serverLane: {
              manifest: serverLaneResult.manifest,
              brief: serverLaneResult.brief,
              briefWritten: serverLaneResult.briefWritten
            }
          }
        : {})
    }
  } catch (error) {
    restoreSnapshot(options.root, snapshot)
    throw error
  }
}

/** "Nothing to install: Google Analytics already exists in index.html and was left untouched." */
export function nothingToInstallMessage(plan: InstallPlan): string {
  const existing = plan.adopted.map(
    (entry) => `${providerLabels[entry.provider]} already exists in ${entry.file}`
  )
  return `Nothing to install: ${existing.join("; ")} and ${plan.adopted.length === 1 ? "was" : "were"} left untouched.`
}

export interface FileSnapshot {
  relativePath: string
  contents: string | null
}

export function snapshotFiles(root: string, relativePaths: string[]): FileSnapshot[] {
  return relativePaths.map((relativePath) => {
    const absolutePath = join(root, relativePath)
    return {
      relativePath,
      contents: existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
    }
  })
}

export function restoreSnapshot(root: string, snapshot: FileSnapshot[]): void {
  for (const file of snapshot) {
    const absolutePath = join(root, file.relativePath)
    const current = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
    if (current === file.contents) {
      continue
    }

    if (file.contents === null) {
      rmSync(absolutePath, { force: true })
    } else {
      writeFileAtomic(absolutePath, file.contents)
    }
  }
}
