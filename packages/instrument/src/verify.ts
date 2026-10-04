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
  // exact gap the entrypoint-left-unmanaged design opens. But verify reflects ON-DISK reality: once
  // the user adds the wiring the requirement is SATISFIED and clears, so "add it, then re-run verify"
  // actually succeeds. Only wiring genuinely still absent stays pending.
  const stillPending = (manifest.requiresManual ?? []).filter(
    (requirement) => !manualRequirementSatisfied(options.root, requirement)
  )
  for (const pending of stillPending) {
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
    ...(stillPending.length > 0
      ? { requiresManual: stillPending.map(({ path, reason }) => ({ path, reason })) }
      : {})
  }
}

/**
 * A recorded manual requirement is satisfied once its target file actually contains the wiring —
 * every non-blank line of the recorded snippet (the import + the boot call) present in the file.
 * Whitespace/blank-line reformatting is tolerated; a missing import OR missing boot call is not.
 */
function manualRequirementSatisfied(
  root: string,
  requirement: { path: string; snippet: string }
): boolean {
  const absolutePath = join(root, requirement.path)
  if (!existsSync(absolutePath)) return false
  const contents = readFileSync(absolutePath, "utf8")
  const requiredLines = requirement.snippet
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return requiredLines.length > 0 && requiredLines.every((line) => contents.includes(line))
}
