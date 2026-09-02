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
    throw new Error(
      "Corrupt .infinite/install.json — cannot parse manifest. Remove it manually to reset."
    )
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
  for (const relativePath of Object.keys(manifest.configOwnership ?? {})) {
    assertConfinedManifestFileEntry(root, relativePath)
  }
  for (const relativePath of [
    manifest.serverLane?.middleware,
    manifest.serverLane?.module,
    manifest.serverLane?.brief,
    manifest.serverLane?.guide,
    ...(manifest.serverLane?.created ?? []),
    ...(manifest.serverLane?.createdDirs ?? [])
  ]) {
    if (relativePath !== undefined) {
      assertConfinedManifestFileEntry(root, relativePath)
    }
  }
  // verify joins requiresManual[].path to read the target file, so it must stay inside the root too.
  for (const requirement of manifest.requiresManual ?? []) {
    assertConfinedManifestFileEntry(root, requirement.path)
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
    candidate.contentHashes !== null &&
    (candidate.configOwnership === undefined || isConfigOwnershipShape(candidate.configOwnership)) &&
    (candidate.serverLane === undefined || isServerLaneManifestShape(candidate.serverLane))
  )
}

const SERVER_LANE_MODES = [
  "next-middleware",
  "vercel-middleware",
  "netlify-edge",
  "cloudflare-pages",
  "node-module",
  "brief"
] as const

function isServerLaneManifestShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (!SERVER_LANE_MODES.some((mode) => mode === candidate.mode)) return false
  for (const key of ["created", "createdDirs"] as const) {
    const value = candidate[key]
    if (value !== undefined && (!Array.isArray(value) || !value.every((entry) => typeof entry === "string"))) {
      return false
    }
  }
  return (["middleware", "module", "brief"] as const).every(
    (key) => candidate[key] === undefined || typeof candidate[key] === "string"
  )
}

function isConfigOwnershipShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false
    const candidate = entry as Record<string, unknown>
    if (candidate.kind === "created") return typeof candidate.installedHash === "string"
    if (candidate.kind === "text-edits") {
      return (
        typeof candidate.originalHash === "string" &&
        typeof candidate.installedHash === "string" &&
        Array.isArray(candidate.edits) &&
        candidate.edits.every(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            Number.isInteger((item as Record<string, unknown>).offset) &&
            ((item as Record<string, unknown>).offset as number) >= 0 &&
            typeof (item as Record<string, unknown>).removed === "string" &&
            typeof (item as Record<string, unknown>).inserted === "string"
        )
      )
    }
    return (
      candidate.kind === "vercel-json-insertions" &&
      typeof candidate.originalHash === "string" &&
      typeof candidate.installedHash === "string" &&
      Array.isArray(candidate.insertions) &&
      candidate.insertions.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          Number.isInteger((item as Record<string, unknown>).offset) &&
          ((item as Record<string, unknown>).offset as number) >= 0 &&
          typeof (item as Record<string, unknown>).text === "string"
      )
    )
  })
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

export function computeContentHashes(root: string, files: string[]): Record<string, string> {
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

export function computeContentHash(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}
