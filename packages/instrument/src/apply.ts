import { existsSync, readFileSync, rmSync } from "node:fs"
import { join, relative } from "node:path"

import { writeFileAtomic } from "./frameworks/shared.js"
import { getFrameworkAdapter } from "./frameworks/index.js"
import {
  computeContentHashes,
  installManifestRelativePath,
  writeInstallManifestIfChanged
} from "./manifest.js"
import type {
  ApplyResult,
  InstallManifest,
  InstallPlan,
  ProviderId,
  SupportedFramework
} from "./types.js"

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

  const frameworkAdapter = getFrameworkAdapter(options.plan.framework)
  if (!frameworkAdapter?.apply) {
    throw new Error(`No apply implementation is registered for ${options.plan.framework}.`)
  }

  const snapshot = snapshotFiles(options.root, [
    ...options.plan.files,
    installManifestRelativePath
  ])

  try {
    const frameworkResult = frameworkAdapter.apply({
      root: options.root,
      appRoot: options.plan.appRoot,
      plan: options.plan
    })

    const manifest: InstallManifest = {
      workspaceId: options.workspaceId,
      appRoot: options.plan.appRoot,
      framework: options.plan.framework as SupportedFramework,
      providers: options.plan.providers as ProviderId[],
      files: options.plan.files,
      envKeys: options.plan.envKeys,
      contentHashes: computeContentHashes(options.root, options.plan.files),
      wiringVersion: 1,
      verifiedAt: null
    }

    const manifestWrite = writeInstallManifestIfChanged(options.root, manifest)
    const changedFiles = [...frameworkResult.changedFiles]
    if (manifestWrite.changed) {
      changedFiles.push(relative(options.root, manifestWrite.manifestPath) || ".infinite/install.json")
    }

    return {
      changedFiles,
      manifestPath: manifestWrite.manifestPath,
      warnings: frameworkResult.warnings
    }
  } catch (error) {
    restoreSnapshot(options.root, snapshot)
    throw error
  }
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
