import { existsSync, readFileSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

import { derivePosthogRegionHosts } from "./providers/validate.js"
import type {
  InfiniteConsentMode,
  InfiniteProxySpec,
  PackageManager,
  WorkspaceInstallArtifacts
} from "./types.js"

/**
 * The DEFAULT Infinite API host. It is a known rebrand landmine (api.ultima.inc → api.infinite.fast,
 * which is not live yet), so every destination below derives from it and an install can override
 * it with `--infinite-api-origin` / `INFINITE_API_ORIGIN` (see `resolveInfiniteApiOrigin`).
 */
export const INFINITE_API_ORIGIN = "https://api.ultima.inc"

/**
 * Browser-facing same-origin route. `/infinite/ledger` deliberately avoids the `events/collect`
 * wording that privacy blocklists match. An artifact that already records another path keeps it —
 * the default applies only when no path was recorded.
 */
export const DEFAULT_INFINITE_COLLECT_PATH = "/infinite/ledger"

/** The Vercel-only upstream destination for `origin` (the browser never sees it). */
export function infiniteCollectDestination(origin: string): string {
  return `${origin}/api/analytics/events/collect`
}

/** The upstream destination at the DEFAULT origin. */
export const INFINITE_COLLECT_DESTINATION = infiniteCollectDestination(INFINITE_API_ORIGIN)

export const INFINITE_API_ORIGIN_ERROR = "--infinite-api-origin must be an https origin with no path"

/**
 * The API origin an install proxies to: the flag, else `INFINITE_API_ORIGIN` from the env, else
 * the default. Only an https origin with a hostname is accepted — no path, query, hash, or
 * credentials — because the collect route is appended to it verbatim.
 */
export function resolveInfiniteApiOrigin(
  options: { flag?: string; env?: NodeJS.ProcessEnv } = {}
): string {
  const fromEnv = options.env?.INFINITE_API_ORIGIN?.trim()
  const candidate = options.flag ?? (fromEnv ? fromEnv : undefined) ?? INFINITE_API_ORIGIN
  return normalizeInfiniteApiOrigin(candidate)
}

function normalizeInfiniteApiOrigin(candidate: string): string {
  const trimmed = candidate.trim()
  if (!/^https:\/\/[^/?#]+\/?$/.test(trimmed)) {
    throw new Error(INFINITE_API_ORIGIN_ERROR)
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(INFINITE_API_ORIGIN_ERROR)
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hostname === "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/"
  ) {
    throw new Error(INFINITE_API_ORIGIN_ERROR)
  }
  return parsed.origin
}

/**
 * Server lane (lossless analytics): the customer's SERVER posts signed document-request and
 * outcome events here, and `verify --server-lane` reads the receipt from the sibling route.
 * Both ride the same source key + HMAC secret; neither is ever called from a browser.
 */
export const INFINITE_SERVER_EVENTS_DESTINATION = `${INFINITE_API_ORIGIN}/api/analytics/events/server`
export const INFINITE_SERVER_LANE_RECEIPT_URL = `${INFINITE_API_ORIGIN}/api/analytics/site/server-lane/receipt`

/**
 * The browser-facing first-party path PostHog is served under when `--posthog-proxy` is on.
 * It becomes the injected api_host AND the rewrite source prefix, so both single-source it.
 */
export const DEFAULT_POSTHOG_PROXY_PATH = "/ingest"

export interface WorkspaceArtifactOptions {
  artifactFile?: string
  ga4MeasurementId?: string
  posthogProjectKey?: string
  posthogApiHost?: string
  xPixelId?: string
  xEventTagIds?: string[]
  metaPixelId?: string
  infiniteSiteSourceKey?: string
  infiniteCollectPath?: string
  infiniteProductionHosts?: string[]
  infiniteStaticProxy?: "vercel"
  infiniteConsentMode?: InfiniteConsentMode
  infiniteDownloadDestinationPath?: string
  /** Validated override of the API host the same-origin route proxies to (default INFINITE_API_ORIGIN). */
  infiniteApiOrigin?: string
  /** `--infinite-autocapture on|off` (absent = on). */
  infiniteAutocapture?: boolean
  packageManager?: PackageManager
}

export function normalizeInfiniteAutocapture(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (normalized === "on") return true
  if (normalized === "off") return false
  throw new Error("--infinite-autocapture currently supports only: on, off")
}

export function normalizeInfiniteConsentMode(value: string): InfiniteConsentMode {
  const normalized = value.trim().toLowerCase().replace("-", "_")
  if (normalized === "required" || normalized === "not_required") {
    return normalized
  }

  throw new Error("--infinite-consent-mode currently supports only: required, not-required")
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
  const topLevelProductionHosts = Array.isArray(record.productionHosts)
    ? record.productionHosts.filter((host): host is string => typeof host === "string")
    : undefined

  const infinite = asRecord(record.infinite)
  if (
    infinite &&
    (typeof infinite.siteSourceKey === "string" ||
      typeof infinite.collectPath === "string" ||
      Array.isArray(infinite.productionHosts) ||
      infinite.staticProxy === "vercel")
  ) {
    artifacts.infinite = {
      siteSourceKey:
        typeof infinite.siteSourceKey === "string" ? infinite.siteSourceKey : "",
      collectPath:
        typeof infinite.collectPath === "string"
          ? infinite.collectPath
          : DEFAULT_INFINITE_COLLECT_PATH,
      productionHosts: Array.isArray(infinite.productionHosts)
        ? infinite.productionHosts.filter((host): host is string => typeof host === "string")
        : [],
      ...(infinite.staticProxy === "vercel" ? { staticProxy: "vercel" as const } : {}),
      ...(typeof infinite.consentMode === "string"
        ? { consentMode: normalizeInfiniteConsentMode(infinite.consentMode) }
        : {}),
      ...(typeof infinite.downloadDestinationPath === "string"
        ? { downloadDestinationPath: infinite.downloadDestinationPath }
        : {}),
      ...(typeof infinite.apiOrigin === "string" ? { apiOrigin: infinite.apiOrigin } : {}),
      ...(typeof infinite.autocapture === "boolean" ? { autocapture: infinite.autocapture } : {})
    }
  }
  const runtimeProductionHosts = topLevelProductionHosts ?? artifacts.infinite?.productionHosts
  if (runtimeProductionHosts !== undefined) {
    artifacts.productionHosts = runtimeProductionHosts
  }

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

  const meta = asRecord(record.meta)
  if (meta && typeof meta.pixelId === "string") {
    artifacts.meta = { pixelId: meta.pixelId }
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
  providers: Array<"infinite" | "ga4" | "posthog" | "x" | "meta">
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

  const providers = (["infinite", "ga4", "posthog", "x", "meta"] as const).filter(
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

  if (options.infiniteProductionHosts !== undefined) {
    artifacts.productionHosts = options.infiniteProductionHosts
  }

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

  if (options.metaPixelId) {
    artifacts.meta = { pixelId: options.metaPixelId }
  }

  if (
    options.infiniteSiteSourceKey !== undefined ||
    options.infiniteCollectPath !== undefined ||
    options.infiniteStaticProxy !== undefined ||
    options.infiniteConsentMode !== undefined ||
    options.infiniteDownloadDestinationPath !== undefined
  ) {
    artifacts.infinite = {
      siteSourceKey:
        options.infiniteSiteSourceKey ?? artifacts.infinite?.siteSourceKey ?? "",
      collectPath:
        options.infiniteCollectPath ??
        artifacts.infinite?.collectPath ??
        DEFAULT_INFINITE_COLLECT_PATH,
      productionHosts:
        options.infiniteProductionHosts ??
        artifacts.productionHosts ??
        artifacts.infinite?.productionHosts ?? [],
      ...(options.infiniteStaticProxy ?? artifacts.infinite?.staticProxy
        ? { staticProxy: "vercel" as const }
        : {}),
      ...(options.infiniteConsentMode ?? artifacts.infinite?.consentMode
        ? { consentMode: options.infiniteConsentMode ?? artifacts.infinite?.consentMode }
        : {}),
      ...((options.infiniteDownloadDestinationPath ??
        artifacts.infinite?.downloadDestinationPath) !== undefined
        ? {
            downloadDestinationPath:
              options.infiniteDownloadDestinationPath ??
              artifacts.infinite?.downloadDestinationPath
          }
        : {}),
      ...(artifacts.infinite?.apiOrigin !== undefined
        ? { apiOrigin: artifacts.infinite.apiOrigin }
        : {}),
      ...(artifacts.infinite?.autocapture !== undefined
        ? { autocapture: artifacts.infinite.autocapture }
        : {})
    }
  }

  // Modifiers, not sources: the origin and the autocapture flag attach to an Infinite artifact
  // that exists for another reason (flags or file) and never fabricate a keyless one.
  const modified = applyInfiniteAutocapture(
    applyInfiniteApiOrigin(artifacts, { origin: options.infiniteApiOrigin }),
    { autocapture: options.infiniteAutocapture }
  )
  if (modified.infinite !== undefined) artifacts.infinite = modified.infinite

  if (artifacts.infinite && options.infiniteProductionHosts !== undefined) {
    artifacts.infinite = {
      ...artifacts.infinite,
      productionHosts: options.infiniteProductionHosts
    }
  }

  return artifacts
}

/**
 * Layer `--infinite-download-destination-path` onto a resolved/discovered Infinite artifact.
 * It is a modifier, not a source: without an Infinite source artifact there is nothing to
 * instrument, so it must not fabricate a keyless source.
 */
export function applyInfiniteDownloadDestinationPath(
  artifacts: WorkspaceInstallArtifacts,
  options: { path?: string }
): WorkspaceInstallArtifacts {
  if (options.path === undefined || artifacts.infinite === undefined) {
    return artifacts
  }

  return {
    ...artifacts,
    infinite: {
      ...artifacts.infinite,
      downloadDestinationPath: options.path
    }
  }
}

/**
 * Layer a resolved `--infinite-api-origin` / `INFINITE_API_ORIGIN` onto a resolved/discovered
 * Infinite artifact. A modifier, not a source: with no Infinite artifact there is nothing to
 * proxy, so it never fabricates one.
 */
export function applyInfiniteApiOrigin(
  artifacts: WorkspaceInstallArtifacts,
  options: { origin?: string }
): WorkspaceInstallArtifacts {
  if (options.origin === undefined || artifacts.infinite === undefined) {
    return artifacts
  }

  return {
    ...artifacts,
    infinite: {
      ...artifacts.infinite,
      apiOrigin: options.origin
    }
  }
}

/**
 * Layer `--infinite-autocapture on|off` onto a resolved/discovered Infinite artifact. A modifier:
 * with no Infinite artifact there is no runtime to configure, so it never fabricates one.
 */
export function applyInfiniteAutocapture(
  artifacts: WorkspaceInstallArtifacts,
  options: { autocapture?: boolean }
): WorkspaceInstallArtifacts {
  if (options.autocapture === undefined || artifacts.infinite === undefined) {
    return artifacts
  }

  return {
    ...artifacts,
    infinite: {
      ...artifacts.infinite,
      autocapture: options.autocapture
    }
  }
}

/**
 * Layer the PostHog reverse proxy onto a resolved artifact after discovery so
 * `--posthog-proxy` can attach to a discovered project key. It only
 * ever MODIFIES an existing posthog artifact — with no project key there
 * is no posthog artifact and nothing to proxy (matches today's key-required behavior); it never
 * fabricates a keyless one. The region hosts are derived from the CURRENT (pre-proxy) apiHost,
 * then api_host is rewritten to the first-party `/ingest` path and the proxy spec (which the
 * framework adapter reads to inject the rewrites) is attached. ui_host defaults to the region's
 * PostHog app host unless the founder overrode it with `--posthog-ui-host`.
 */
export function applyPosthogProxy(
  artifacts: WorkspaceInstallArtifacts,
  options: { proxy?: boolean; uiHost?: string }
): WorkspaceInstallArtifacts {
  if (!options.proxy || !artifacts.posthog) {
    return artifacts
  }

  const { ingestHost, assetsHost, uiHost: regionUiHost } = derivePosthogRegionHosts(
    artifacts.posthog.apiHost
  )

  return {
    ...artifacts,
    posthog: {
      ...artifacts.posthog,
      apiHost: DEFAULT_POSTHOG_PROXY_PATH,
      uiHost: options.uiHost ?? regionUiHost,
      proxy: {
        path: DEFAULT_POSTHOG_PROXY_PATH,
        assetsHost,
        ingestHost
      }
    }
  }
}

export function infiniteProxySpec(
  artifact: WorkspaceInstallArtifacts["infinite"]
): InfiniteProxySpec | undefined {
  return artifact
    ? {
        path: artifact.collectPath,
        destination: infiniteCollectDestination(artifact.apiOrigin ?? INFINITE_API_ORIGIN)
      }
    : undefined
}
