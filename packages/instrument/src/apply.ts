import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

import { normalizeAppRelativePath, writeFileAtomic } from "./frameworks/shared.js"
import { getFrameworkAdapter } from "./frameworks/index.js"
import {
  assertReceiptDescribesApp,
  computeContentHashes,
  installManifestPath,
  installManifestRelativePath,
  mergeInstallManifest,
  readInstallManifest,
  writeInstallManifestIfChanged
} from "./manifest.js"
import { manifestIdsFor } from "./install/keys-adapter.js"
import { SERVER_LANE_GUIDE_FILE } from "./server-lane/copy.js"
import { applyServerLane } from "./server-lane/install.js"
import type {
  ApplyResult,
  InstallManifest,
  InstallPlan,
  ManualRequirement,
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

  // Managed code that serves ADOPTED tools is installable on its own: the conversion helpers
  // (decisions 9 and 13) and the Meta `_fbc` capture beside an adopted pixel (`captureOnly`). A plan
  // whose every provider was adopted still writes them.
  const managedForAdopted = options.plan.instructions.some(
    (instruction) => instruction.helpers === true || instruction.provider !== undefined
  )

  // Every requested provider already exists (adopted), nothing else managed was planned and no server
  // lane was asked for: there is nothing to write, so nothing is written — no empty managed block, no
  // manifest.
  if (options.plan.providers.length === 0 && !managedForAdopted && !options.plan.serverLane) {
    return {
      changedFiles: [],
      manifestPath: installManifestPath(options.root),
      warnings: [nothingToInstallMessage(options.plan)]
    }
  }

  // A server-lane-only plan (no provider artifacts, no managed helpers) skips the pixel adapter entirely.
  const runAdapter = options.plan.providers.length > 0 || managedForAdopted || !options.plan.serverLane
  const frameworkAdapter = getFrameworkAdapter(options.plan.framework)
  if (runAdapter && !frameworkAdapter?.apply) {
    throw new Error(`No apply implementation is registered for ${options.plan.framework}.`)
  }

  const snapshot = snapshotFiles(options.root, [
    ...options.plan.files,
    // The lane's brief AND its docs guide, so a refusal below rolls every lane write back (the wizard's
    // snapshot already lists both, P3-21).
    ...(options.plan.serverLane
      ? [options.plan.serverLane.briefPath, normalizeAppRelativePath(options.plan.appRoot, SERVER_LANE_GUIDE_FILE)]
      : []),
    installManifestRelativePath
  ])

  try {
    // A corrupt receipt throws here, before anything is written (never a silent reset), and so does a
    // receipt for another app: this run's record is merged into it below.
    const previousManifest = readInstallManifest(options.root)
    assertReceiptDescribesApp(previousManifest, {
      appRoot: options.plan.appRoot,
      framework: options.plan.framework as SupportedFramework
    })
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

    // A lane PATCH of the customer's own file (text edits / vercel.json insertions) is reversed by exact
    // offsets after uninstall has reversed the recorded edits; patched on top of an earlier run's recorded
    // edit, neither could come off byte for byte, so it is refused and rolled back. The lane's own WHOLE
    // files (a created middleware, the module, the outcome helper) stay re-renderable: a managed refresh
    // records edits on those, and an upgrade must still be able to rewrite them.
    const laneWritten = new Set(serverLaneResult?.changedFiles ?? [])
    const lanePatched = (file: string): boolean => {
      const ownership = serverLaneResult?.configOwnership?.[file]
      return laneWritten.has(file) && ownership !== undefined && ownership.kind !== "created"
    }
    const editedBeneath = [...new Set((previousManifest?.edits ?? []).map((edit) => edit.file))].filter(lanePatched)
    if (editedBeneath.length > 0) {
      throw new Error(
        `Refusing to install the server lane: ${editedBeneath.join(", ")} carries an edit an earlier infinite-tag run recorded, and uninstall could not then reverse both byte for byte. The install was rolled back: every file it wrote is restored (an empty directory it created may remain). Run npx infinite-tag uninstall first, then install again.`
      )
    }

    const configOwnership = {
      ...(frameworkResult.configOwnership ?? {}),
      ...(serverLaneResult?.configOwnership ?? {})
    }
    const requiresManual = frameworkResult.requiresManual ?? []
    const managedFiles = managedFilesOfRun(options.plan, requiresManual)
    // This run's own record, merged into the receipt already there (never replacing it): a server-lane
    // run after the browser tag keeps the tag's files, edits, capture, providers and ids, and the reverse.
    const runManifest: InstallManifest = {
      workspaceId: options.workspaceId,
      appRoot: options.plan.appRoot,
      framework: options.plan.framework as SupportedFramework,
      ...(runAdapter ? { browserTag: true as const } : {}),
      providers: options.plan.providers as ProviderId[],
      files: managedFiles,
      envKeys: options.plan.envKeys,
      contentHashes: computeContentHashes(options.root, managedFiles),
      ...(Object.keys(configOwnership).length > 0 ? { configOwnership } : {}),
      ...(serverLaneResult ? { serverLane: serverLaneResult.manifest } : {}),
      // The `requires_manual_snippet` state: recorded WITH the snippet so verify can later confirm the
      // wiring is actually present on disk (satisfied) instead of replaying a stale requirement.
      ...(requiresManual.length > 0 ? { requiresManual } : {}),
      // The public ids the browser tag this run wrote carries (merged per tool into the earlier receipt's).
      ...(runAdapter ? { ids: manifestIdsFor(options.plan.artifacts) } : {}),
      wiringVersion: 1,
      verifiedAt: null
    }
    const manifest = mergeInstallManifest(previousManifest, runManifest, {
      browser: runAdapter,
      serverLane: serverLaneResult !== null,
      laneDisowned: (options.plan.serverLane?.created ?? []).filter((file) => file.action === "manual").map((file) => file.path)
    })

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

/**
 * The managed files THIS run wrote and recorded: the plan's files minus those left to the owner. The
 * post-install static check hash-verifies only these; the receipt's earlier entries are carried.
 */
export function managedFilesOfRun(plan: InstallPlan, requiresManual: readonly ManualRequirement[] | undefined): string[] {
  const ownerFiles = new Set((requiresManual ?? []).filter((requirement) => requirement.ownerBoundary).map((requirement) => requirement.path))
  return plan.files.filter((file) => !ownerFiles.has(file))
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
