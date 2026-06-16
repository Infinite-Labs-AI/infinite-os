import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import type { PackageManager, WorkspaceInstallArtifacts } from "./types.js"

export interface WorkspaceArtifactOptions {
  artifactFile?: string
  ga4MeasurementId?: string
  posthogProjectKey?: string
  posthogApiHost?: string
  xPixelId?: string
  xEventTagIds?: string[]
  packageManager?: PackageManager
}

export function readWorkspaceArtifactsFile(
  root: string,
  artifactFile?: string
): WorkspaceInstallArtifacts {
  if (!artifactFile) {
    return {}
  }

  const artifactPath = artifactFile.startsWith("/")
    ? artifactFile
    : join(root, artifactFile)
  if (!existsSync(artifactPath)) {
    throw new Error(`Artifact file not found: ${artifactPath}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(artifactPath, "utf8"))
  } catch (error) {
    throw new Error(
      `Artifact file ${artifactPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  return coerceWorkspaceArtifacts(parsed)
}

/**
 * Coerce arbitrary parsed JSON into the known artifact shape: only the ga4/posthog/x keys
 * with string fields survive. This stops a hostile or malformed `--artifact-file` from
 * smuggling unexpected structures in; the providers still strictly validate the value
 * FORMATS (G-…, phc_…, https origin) at plan time.
 */
export function coerceWorkspaceArtifacts(value: unknown): WorkspaceInstallArtifacts {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Artifact file must contain a JSON object.")
  }
  const record = value as Record<string, unknown>
  const artifacts: WorkspaceInstallArtifacts = {}

  const ga4 = asRecord(record.ga4)
  if (ga4 && typeof ga4.measurementId === "string") {
    artifacts.ga4 = { measurementId: ga4.measurementId }
  }

  const posthog = asRecord(record.posthog)
  if (posthog && (typeof posthog.projectKey === "string" || typeof posthog.apiHost === "string")) {
    artifacts.posthog = {
      projectKey: typeof posthog.projectKey === "string" ? posthog.projectKey : "",
      apiHost: typeof posthog.apiHost === "string" ? posthog.apiHost : ""
    }
  }

  const x = asRecord(record.x)
  if (x) {
    const eventTagIds = Array.isArray(x.eventTagIds)
      ? x.eventTagIds.filter((id): id is string => typeof id === "string")
      : []
    if (typeof x.pixelId === "string" || eventTagIds.length > 0) {
      artifacts.x = {
        pixelId: typeof x.pixelId === "string" ? x.pixelId : "",
        eventTagIds
      }
    }
  }

  return artifacts
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Where `infinite setup` saves the public handoff files; INFINITE_ARTIFACTS_DIR overrides (tests). */
export function defaultArtifactsDir(): string {
  const override = process.env.INFINITE_ARTIFACTS_DIR?.trim()
  return override ? override : join(homedir(), ".infinite", "artifacts")
}

export interface DiscoveredWorkspaceArtifacts {
  filePath: string
  /** Workspace id recorded in the file (or its file name); callers adopt it only when no --workspace was given. */
  workspaceId?: string
  providers: Array<"ga4" | "posthog" | "x">
  artifacts: WorkspaceInstallArtifacts
}

/**
 * Same-machine flag-free install: `infinite setup` saves the captured PUBLIC artifacts to
 * `~/.infinite/artifacts/<workspaceId>.json`; when the founder passes no artifact flags and
 * no --artifact-file, the CLI discovers that file here. With a --workspace, only that
 * workspace's file is considered; without one, a single saved file is used (adopting its
 * workspace id) while multiple files are listed and never guessed between. Unreadable or
 * malformed files warn and behave as if absent. Callers must not invoke discovery when any
 * explicit artifact input was given — explicit flags and --artifact-file always win.
 */
export function discoverWorkspaceArtifacts(options: {
  workspaceId?: string
  warn?: (message: string) => void
}): DiscoveredWorkspaceArtifacts | null {
  const warn = options.warn ?? (() => undefined)
  const dir = defaultArtifactsDir()
  if (!existsSync(dir)) {
    return null
  }

  if (options.workspaceId !== undefined) {
    if (!isSafeArtifactFileStem(options.workspaceId)) {
      return null
    }
    const filePath = join(dir, `${options.workspaceId}.json`)
    return existsSync(filePath) ? readDiscoveredArtifactsFile(filePath, warn) : null
  }

  let names: string[]
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
  } catch (error) {
    warn(`Could not read the saved artifacts directory ${dir}: ${errorMessage(error)}`)
    return null
  }
  if (names.length === 0) {
    return null
  }
  if (names.length > 1) {
    warn(
      [
        `Found ${names.length} saved artifact files in ${dir}:`,
        ...names.map((name) => `  - ${name}`),
        "Pass --workspace <id> to pick one; infinite-tag will not guess."
      ].join("\n")
    )
    return null
  }
  return readDiscoveredArtifactsFile(join(dir, names[0]), warn)
}

function readDiscoveredArtifactsFile(
  filePath: string,
  warn: (message: string) => void
): DiscoveredWorkspaceArtifacts | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"))
  } catch (error) {
    warn(`Ignoring saved artifact file ${filePath}: ${errorMessage(error)}`)
    return null
  }

  let artifacts: WorkspaceInstallArtifacts
  try {
    artifacts = coerceWorkspaceArtifacts(parsed)
  } catch (error) {
    warn(`Ignoring saved artifact file ${filePath}: ${errorMessage(error)}`)
    return null
  }

  const providers = (["ga4", "posthog", "x"] as const).filter(
    (provider) => artifacts[provider] !== undefined
  )
  if (providers.length === 0) {
    warn(`Ignoring saved artifact file ${filePath}: it contains no usable public artifacts.`)
    return null
  }

  const record = asRecord(parsed)
  const recordedWorkspaceId =
    typeof record?.workspaceId === "string" && record.workspaceId.trim()
      ? record.workspaceId.trim()
      : undefined
  return {
    filePath,
    workspaceId: recordedWorkspaceId ?? basename(filePath, ".json"),
    providers: [...providers],
    artifacts
  }
}

function isSafeArtifactFileStem(workspaceId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workspaceId)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function resolveWorkspaceArtifacts(
  root: string,
  options: WorkspaceArtifactOptions
): WorkspaceInstallArtifacts {
  const fromFile = readWorkspaceArtifactsFile(root, options.artifactFile)
  const artifacts: WorkspaceInstallArtifacts = { ...fromFile }

  if (options.ga4MeasurementId) {
    artifacts.ga4 = { measurementId: options.ga4MeasurementId }
  }

  if (options.posthogProjectKey || options.posthogApiHost) {
    artifacts.posthog = {
      projectKey: options.posthogProjectKey ?? artifacts.posthog?.projectKey ?? "",
      apiHost: options.posthogApiHost ?? artifacts.posthog?.apiHost ?? ""
    }
  }

  if (options.xPixelId || options.xEventTagIds?.length) {
    artifacts.x = {
      pixelId: options.xPixelId ?? artifacts.x?.pixelId ?? "",
      eventTagIds: options.xEventTagIds ?? artifacts.x?.eventTagIds ?? []
    }
  }

  return artifacts
}
