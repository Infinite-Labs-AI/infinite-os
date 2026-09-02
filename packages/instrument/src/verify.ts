import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { readInstallManifest } from "./manifest.js"
import type { VerifyResult } from "./types.js"

export interface VerifyInstallationOptions {
  root: string
}

const FORBIDDEN_INFINITE_LOADER_MARKERS = ["app.ultima.inc", "/tracking/", "/sdk/"]

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
  let requiredConsentRuntimeFound = false

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

    const contents = readFileSync(absolutePath)
    const actualHash = createHash("sha256").update(contents).digest("hex")
    if (actualHash !== expectedHash) {
      failures.push(`Managed file content drifted from manifest: ${relativePath}`)
      continue
    }

    const source = contents.toString("utf8")
    if (FORBIDDEN_INFINITE_LOADER_MARKERS.some((marker) => source.includes(marker))) {
      failures.push(`Managed file contains a forbidden external Infinite loader route: ${relativePath}`)
      continue
    }
    if (source.includes('"consent":{"mode":"required"')) {
      requiredConsentRuntimeFound = true
      if (!source.includes("infinite:analytics-consent-change")) {
        failures.push(`Managed Infinite runtime is missing its required consent event bridge: ${relativePath}`)
        continue
      }
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

  // A recorded manual step means the managed files can verify while the pixel is NOT live yet — the
  // exact gap the entrypoint-left-unmanaged design opens. Surface it so verify never reads as "done".
  const requiresManual = manifest.requiresManual ?? []
  for (const pending of requiresManual) {
    routeChecks.push(
      `ACTION REQUIRED: ${pending.path} still needs the manual wiring line (${pending.reason}) — the pixel is not live until it is added.`
    )
  }

  const beaconChecks = manifest.providers.map(
    (provider) => `${provider}: manifest-backed wiring is present in the managed install files.`
  )
  if (requiredConsentRuntimeFound && manifest.providers.includes("infinite")) {
    beaconChecks.push(
      "infinite: required mode is wired for infinite:analytics-consent-change; verify the external consent UI dispatches grant and revoke events in a browser."
    )
  }

  return {
    buildOk: failures.length === 0,
    routeChecks,
    beaconChecks,
    warnings: [
      "Static verification only. Runtime beacon delivery still requires a browser/network check."
    ],
    ...(requiresManual.length > 0 ? { requiresManual } : {})
  }
}
