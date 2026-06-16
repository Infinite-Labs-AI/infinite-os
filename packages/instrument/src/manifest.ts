import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  assertConfinedManifestFileEntry,
  resolveConfinedAppRoot,
  writeFileAtomic
} from "./frameworks/shared.js"
import type { InstallManifest } from "./types.js"

export const installManifestRelativePath = ".infinite/install.json"

export function installManifestPath(root: string): string {
  return join(root, installManifestRelativePath)
}

export function readInstallManifest(root: string): InstallManifest | null {
  const manifestPath = installManifestPath(root)
  if (!existsSync(manifestPath)) {
    return null
  }

  const raw = readFileSync(manifestPath, "utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Corrupt .infinite/install.json — cannot parse manifest. Remove it manually to reset.")
  }

  if (!isInstallManifestShape(parsed)) {
    throw new Error(
      "Corrupt .infinite/install.json — manifest is missing expected fields. Remove it manually to reset."
    )
  }

  assertManifestConfined(root, parsed)

  return parsed
}

// A tampered install.json must never drive reads/writes/removals outside the
// workspace root. Validating here — the single place the manifest is read from
// disk — confines every consumer (uninstall, verify, inspect) at once.
function assertManifestConfined(root: string, manifest: InstallManifest): void {
  resolveConfinedAppRoot(root, manifest.appRoot)
  for (const relativePath of manifest.files) {
    assertConfinedManifestFileEntry(root, relativePath)
  }
}

function isInstallManifestShape(value: unknown): value is InstallManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.workspaceId === "string" &&
    typeof candidate.appRoot === "string" &&
    typeof candidate.framework === "string" &&
    Array.isArray(candidate.providers) &&
    Array.isArray(candidate.files) &&
    Array.isArray(candidate.envKeys) &&
    typeof candidate.contentHashes === "object" &&
    candidate.contentHashes !== null
  )
}

export function writeInstallManifest(root: string, manifest: InstallManifest): string {
  const manifestPath = installManifestPath(root)
  writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath
}

export function writeInstallManifestIfChanged(
  root: string,
  manifest: InstallManifest
): { changed: boolean; manifestPath: string } {
  const manifestPath = installManifestPath(root)
  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`
  const currentContents = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null
  if (currentContents === nextContents) {
    return {
      changed: false,
      manifestPath
    }
  }

  writeFileAtomic(manifestPath, nextContents)

  return {
    changed: true,
    manifestPath
  }
}

export function computeContentHashes(
  root: string,
  files: string[]
): Record<string, string> {
  const contentHashes: Record<string, string> = {}
  for (const relativePath of files) {
    const absolutePath = join(root, relativePath)
    if (!existsSync(absolutePath)) {
      continue
    }

    const hash = createHash("sha256").update(readFileSync(absolutePath)).digest("hex")
    contentHashes[relativePath] = hash
  }

  return contentHashes
}
