import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { readInstallManifest } from "./manifest.js"
import type { VerifyResult } from "./types.js"

export interface VerifyInstallationOptions {
  root: string
}

export function verifyInstallation(options: VerifyInstallationOptions): VerifyResult {
  const manifest = readInstallManifest(options.root)
  if (!manifest) {
    return {
      buildOk: false,
      routeChecks: ["Missing .infinite/install.json"],
      beaconChecks: [],
      warnings: ["Run apply before verify so the manifest exists."]
    }
  }

  const routeChecks = [`Manifest loaded for ${manifest.framework} at ${manifest.appRoot}.`]
  const failures: string[] = []
  let verifiedFileCount = 0

  for (const relativePath of manifest.files) {
    const absolutePath = join(options.root, relativePath)
    if (!existsSync(absolutePath)) {
      failures.push(`Missing managed file: ${relativePath}`)
      continue
    }

    const expectedHash = manifest.contentHashes[relativePath]
    if (!expectedHash) {
      failures.push(`Manifest is missing a content hash for ${relativePath}`)
      continue
    }

    const actualHash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
    if (actualHash !== expectedHash) {
      failures.push(`Managed file content drifted from manifest: ${relativePath}`)
      continue
    }

    verifiedFileCount += 1
  }

  if (failures.length === 0) {
    routeChecks.push(
      `Verified ${verifiedFileCount} managed file${verifiedFileCount === 1 ? "" : "s"} against recorded content hashes.`
    )
  } else {
    routeChecks.push(...failures)
  }

  return {
    buildOk: failures.length === 0,
    routeChecks,
    beaconChecks: manifest.providers.map(
      (provider) => `${provider}: manifest-backed wiring is present in the managed install files.`
    ),
    warnings: [
      "Static verification only. Runtime beacon delivery still requires a browser/network check."
    ]
  }
}
