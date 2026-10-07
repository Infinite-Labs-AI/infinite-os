// R1-15: the §3b keys response → the installer's input (`WorkspaceInstallArtifacts`), plus the wizard
// install's manifest `workspaceId`.
//
// HONEST KEYS ONLY. Every id comes from the user's Infinite connections (the keys verb), never from
// the repo, a flag, an env file or a default. A tool whose connection is missing, failed to read, or
// is ambiguous yields NO artifact — never a placeholder, never a guess. The manifest `workspaceId` is
// `"wizard:" + <first 16 hex of the repoFingerprint>`: stable across machines for the same remote +
// app root, and never a cloud id (`ws_…`) — infinite-os never carries one.
import {
  validateGa4MeasurementId,
  validateInfiniteSiteSourceKey,
  validateMetaPixelId,
  validatePosthogProjectKey
} from "../providers/validate.js"
import type { InfiniteConsentMode, PosthogProxySpec, WorkspaceInstallArtifacts } from "../types.js"
import { DEFAULT_POSTHOG_PROXY_PATH } from "../workspace-artifacts.js"
import type { TagKeys } from "../wizard/contracts/bridge.js"
import { normalizeHost } from "../wizard/contracts/host-deny.js"
import { wizardManifestWorkspaceId, type PlanModel } from "../wizard/contracts/jobs.js"

/**
 * The preview guard a wizard install emits (decision 3; O5's `WorkspaceInstallArtifacts.hostGuard`
 * shape, declared here until O5's field lands: identical shape, so integration only drops this alias).
 */
export interface WizardHostGuard {
  mode: "deny"
  /** Production hosts that always fire (D3: exempt FIRST). */
  exempt: string[]
  /** The deny suffixes/hosts from `contracts/host-deny-v1.json`. */
  deny: string[]
}

/**
 * The installer input a wizard install produces: `WorkspaceInstallArtifacts` plus the two options lane
 * O5 adds to the managed bytes (the preview guard, and D17's sensitive paths on a MANAGED PostHog).
 * Every extra field is optional, so this is assignable to `WorkspaceInstallArtifacts` everywhere.
 */
export type WizardInstallArtifacts = WorkspaceInstallArtifacts & {
  hostGuard?: WizardHostGuard
  posthog?: WorkspaceInstallArtifacts["posthog"] & { sensitivePaths?: string[] }
}

/** Why a tool produced no artifact (for the plan's "connect it" / "pick a stream" lines). */
export type KeysSkipReason =
  | "not_connected"
  | "read_failed"
  | "not_provisioned"
  | "no_pixel"
  | "multiple_pixels"
  | "infinite_dataset"
  | "multiple_streams"
  | "invalid_id"
  | "consent_unanswered"

export interface KeysAdapterResult {
  artifacts: WizardInstallArtifacts
  skipped: Partial<Record<"infinite" | "ga4" | "posthog" | "meta", KeysSkipReason>>
}

/** The PostHog region hosts, from the connection's `region` (never derived from a US default). */
export function posthogProxyFor(keys: TagKeys["posthog"]): PosthogProxySpec | null {
  if (keys.region === "us") {
    return { path: DEFAULT_POSTHOG_PROXY_PATH, ingestHost: "https://us.i.posthog.com", assetsHost: "https://us-assets.i.posthog.com" }
  }
  if (keys.region === "eu") {
    return { path: DEFAULT_POSTHOG_PROXY_PATH, ingestHost: "https://eu.i.posthog.com", assetsHost: "https://eu-assets.i.posthog.com" }
  }
  // Self-hosted: no first-party proxy is planned; the connection's own host is used directly.
  return null
}

/**
 * The GA4 stream for this site. One stream → it. Several → the one whose `defaultUri` host is a
 * production host of this site; anything else (none or two match) → no GA4 artifact: the `keys` step
 * asks the user and passes the keys narrowed to the chosen stream.
 */
function pickGa4Stream(keys: TagKeys): { measurementId: string } | KeysSkipReason {
  const streams = keys.ga4.streams
  if (streams.length === 1) return { measurementId: streams[0]!.measurementId }
  const hosts = new Set(keys.infinite.productionHosts.map(normalizeHost))
  const matching = streams.filter((stream) => {
    if (!stream.defaultUri) return false
    try {
      return hosts.has(normalizeHost(new URL(stream.defaultUri).hostname))
    } catch {
      return false
    }
  })
  return matching.length === 1 ? { measurementId: matching[0]!.measurementId } : "multiple_streams"
}

/**
 * Maps every §3b keys status to an artifact or a skip reason. `answers.consentMode` is the plan's
 * consent decision; without it Infinite's pixel is not installable (the run parks at `plan`).
 */
export interface ArtifactsFromKeysOptions {
  /**
   * The site can serve PostHog through `/ingest` on its own domain (Next's rewrites, or vercel.json on
   * a site Vercel serves). False → PostHog is installed straight to its region host: an `/ingest`
   * api_host with no rewrite behind it would 404 every event. Default true.
   */
  posthogProxy?: boolean
}

export function artifactsFromKeysDetailed(keys: TagKeys, answers: PlanModel["decisions"], options: ArtifactsFromKeysOptions = {}): KeysAdapterResult {
  const artifacts: WizardInstallArtifacts = {}
  const skipped: KeysAdapterResult["skipped"] = {}

  // Infinite: a provisioned site source with its key and collect path, and an answered consent mode.
  const infinite = keys.infinite
  if (infinite.status !== "ready" || !infinite.siteSourceKey || !infinite.collectPath) {
    skipped.infinite = "not_provisioned"
  } else if (validateInfiniteSiteSourceKey(infinite.siteSourceKey) !== null) {
    skipped.infinite = "invalid_id"
  } else {
    const consentMode: InfiniteConsentMode | null = answers.consentMode
    if (consentMode === null) {
      skipped.infinite = "consent_unanswered"
    } else {
      artifacts.infinite = {
        siteSourceKey: infinite.siteSourceKey,
        collectPath: infinite.collectPath,
        productionHosts: [...infinite.productionHosts],
        consentMode
      }
    }
  }
  if (infinite.productionHosts.length > 0) artifacts.productionHosts = [...infinite.productionHosts]

  // GA4
  if (keys.ga4.status !== "connected") {
    skipped.ga4 = keys.ga4.status === "read_failed" ? "read_failed" : "not_connected"
  } else {
    const stream = pickGa4Stream(keys)
    if (typeof stream === "string") skipped.ga4 = stream
    else if (validateGa4MeasurementId(stream.measurementId) !== null) skipped.ga4 = "invalid_id"
    else artifacts.ga4 = { measurementId: stream.measurementId }
  }

  // PostHog: the project key and the connection's own region/hosts; proxied on us/eu.
  const posthog = keys.posthog
  if (posthog.status !== "connected" || !posthog.projectKey || !posthog.apiHost) {
    skipped.posthog = posthog.status === "read_failed" ? "read_failed" : "not_connected"
  } else if (validatePosthogProjectKey(posthog.projectKey) !== null) {
    skipped.posthog = "invalid_id"
  } else {
    const proxy = options.posthogProxy === false ? null : posthogProxyFor(posthog)
    artifacts.posthog = proxy
      ? { projectKey: posthog.projectKey, apiHost: proxy.path, ...(posthog.uiHost ? { uiHost: posthog.uiHost } : {}), proxy }
      : { projectKey: posthog.projectKey, apiHost: posthog.ingestHost ?? posthog.apiHost, ...(posthog.uiHost ? { uiHost: posthog.uiHost } : {}) }
  }

  // Meta: exactly one connected pixel, 15–16 digits. Infinite's own dataset is never installed.
  const meta = keys.meta
  if (meta.status === "connected" && meta.pixels.length === 1) {
    const pixelId = meta.pixels[0]!.pixelId
    if (validateMetaPixelId(pixelId) !== null) skipped.meta = "invalid_id"
    else artifacts.meta = { pixelId, ...(answers.consentMode ? { consentMode: answers.consentMode } : {}) }
  } else {
    skipped.meta =
      meta.status === "infinite_dataset"
        ? "infinite_dataset"
        : meta.status === "no_pixel"
          ? "no_pixel"
          : meta.status === "multiple" || meta.pixels.length > 1
            ? "multiple_pixels"
            : "not_connected"
  }

  return { artifacts: withConversionHelpers(artifacts, answers.conversionNames), skipped }
}

/**
 * §3x.3 (B3) THE one place `conversions.helpers` is set (review P3-4: it used to be set here and again in the installer,
 * so either copy could drift unseen). The helpers are emitted exactly when job 10 is seeded (§3y.5: approved conversion
 * names, and a tool this install writes or keeps managed), so the brief's "the helpers are already in your repo" is
 * never false. The installer calls it again on the artifacts it really writes.
 */
export function withConversionHelpers<T extends WizardInstallArtifacts>(artifacts: T, conversionNames: readonly string[]): T {
  const writesTool = artifacts.infinite !== undefined || artifacts.ga4 !== undefined || artifacts.posthog !== undefined || artifacts.meta !== undefined
  if (conversionNames.length === 0 || !writesTool) {
    if (artifacts.conversions === undefined) return artifacts
    const { conversions: _dropped, ...rest } = artifacts
    return rest as T
  }
  return { ...artifacts, conversions: { helpers: true } }
}

/** `Installer.artifactsFromKeys`: the artifacts only (the skip reasons ride `artifactsFromKeysDetailed`). */
export function artifactsFromKeys(keys: TagKeys, answers: PlanModel["decisions"], options: ArtifactsFromKeysOptions = {}): WizardInstallArtifacts {
  return artifactsFromKeysDetailed(keys, answers, options).artifacts
}

/** The wizard install's manifest `workspaceId` (§3e.6, R1-15). */
export function wizardInstallWorkspaceId(repoFingerprint: string): string {
  return wizardManifestWorkspaceId(repoFingerprint)
}

/** The public ids an install emitted, for the receipt's `ids` block (`doctor` reads it). */
export function manifestIdsFor(artifacts: WorkspaceInstallArtifacts): {
  ga4: string[]
  posthog: { projectKey: string; apiHost: string } | null
  meta: string[]
  infinite: { siteSourceKey: string } | null
} {
  return {
    ga4: artifacts.ga4 ? [artifacts.ga4.measurementId] : [],
    posthog: artifacts.posthog ? { projectKey: artifacts.posthog.projectKey, apiHost: artifacts.posthog.apiHost } : null,
    meta: artifacts.meta ? [artifacts.meta.pixelId] : [],
    infinite: artifacts.infinite ? { siteSourceKey: artifacts.infinite.siteSourceKey } : null
  }
}
