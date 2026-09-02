// Adapters over the tag's inspect/plan functions for the harness: provider detection WITH
// evidence (file, line, public id), key resolution (flags → saved artifacts → .env, never a
// template), the per-provider classification, and the deterministic plan.
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { isManagedInfiniteFile } from "../frameworks/managed-files.js"
import { planInstallation } from "../plan.js"
import {
  validateGa4MeasurementId,
  validateInfiniteSiteSourceKey,
  validateMetaPixelId,
  validatePosthogProjectKey,
  validateXPixelId
} from "../providers/validate.js"
import type {
  InspectResult,
  InstallManifest,
  InstallPlan,
  ProviderId,
  WorkspaceInstallArtifacts
} from "../types.js"
import { DEFAULT_INFINITE_COLLECT_PATH } from "../workspace-artifacts.js"

import { lineNumberAt, readSourceFile, walkSourceFiles } from "./scan.js"
import type {
  DetectedProvider,
  HarnessFailureCode,
  HarnessProviderId,
  KeySource,
  ProviderClassification,
  ResolvedKeys
} from "./types.js"
import { HARNESS_PROVIDER_ORDER } from "./types.js"

export interface DetectedProviderEvidence extends DetectedProvider {
  /** 1-based line of the first signature in that file. */
  line: number
  /** Public id read from the snippet (G-…, GTM-…, phc_…, numeric pixel id). */
  key?: string
}

const managedHtmlBlock = /<!-- infinite:start -->[\s\S]*?<!-- infinite:end -->/g

function firstIndex(contents: string, needles: Array<string | RegExp>): number {
  let best = -1
  for (const needle of needles) {
    const index =
      typeof needle === "string" ? contents.indexOf(needle) : (needle.exec(contents)?.index ?? -1)
    if (index >= 0 && (best < 0 || index < best)) best = index
  }
  return best
}

function firstMatch(contents: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(contents)
  return match ? (match[1] ?? match[0]) : undefined
}

/** Every provider signature one file proves, with evidence. Prose never matches (real loader URLs / call sites only). */
function signaturesIn(contents: string): Array<Omit<DetectedProviderEvidence, "file" | "line"> & { offset: number }> {
  const found: Array<Omit<DetectedProviderEvidence, "file" | "line"> & { offset: number }> = []
  const gtagAt = firstIndex(contents, ["googletagmanager.com/gtag", "gtag("])
  if (gtagAt >= 0) {
    found.push({
      provider: "ga4",
      via: "snippet",
      offset: gtagAt,
      key: firstMatch(contents, /\b(G-[A-Z0-9]{4,})\b/)
    })
  } else {
    const gtmAt = firstIndex(contents, ["googletagmanager.com/gtm.js", /GTM-[A-Z0-9]{4,}/, "dataLayer.push("])
    if (gtmAt >= 0) {
      found.push({
        provider: "ga4",
        via: "gtm",
        offset: gtmAt,
        key: firstMatch(contents, /\b(GTM-[A-Z0-9]{4,})\b/)
      })
    }
  }
  const posthogAt = firstIndex(contents, ["posthog.init(", "i.posthog.com"])
  if (posthogAt >= 0) {
    found.push({ provider: "posthog", via: "snippet", offset: posthogAt, key: firstMatch(contents, /\b(phc_[A-Za-z0-9]+)\b/) })
  }
  const xAt = firstIndex(contents, ["twq(", "static.ads-twitter.com"])
  if (xAt >= 0) {
    found.push({
      provider: "x",
      via: "snippet",
      offset: xAt,
      key: firstMatch(contents, /twq\(\s*['"]config['"]\s*,\s*['"]([a-z0-9]+)['"]/)
    })
  }
  const infiniteAt = firstIndex(contents, ["tracking/standalone.js", "_1BU_CONFIG", "data-1bu-workspace-id"])
  if (infiniteAt >= 0) {
    found.push({ provider: "infinite", via: "snippet", offset: infiniteAt })
  }
  const metaAt = firstIndex(contents, ["fbevents.js", "fbq(", "connect.facebook.net"])
  if (metaAt >= 0) {
    found.push({
      provider: "meta",
      via: "snippet",
      offset: metaAt,
      key: firstMatch(contents, /fbq\(\s*['"]init['"]\s*,\s*['"](\d{5,})['"]/)
    })
  }
  return found
}

/**
 * Provider installs that exist in the app and are NOT managed by Infinite, with file+line
 * evidence and the public id read from the snippet. One entry per (provider, id): the same id
 * in several files is one install (first file in walk order wins); two different ids for one
 * provider come back as two entries, which `classifyProviders` reports as a conflict.
 */
export function detectProvidersWithEvidence(appRootAbsolute: string): DetectedProviderEvidence[] {
  const entries: DetectedProviderEvidence[] = []
  const seen = new Set<string>()
  for (const file of walkSourceFiles(appRootAbsolute)) {
    const raw = readSourceFile(appRootAbsolute, file)
    if (raw === null || isManagedInfiniteFile(raw)) continue
    const contents = raw.replace(managedHtmlBlock, "")
    for (const signature of signaturesIn(contents)) {
      const identity = `${signature.provider}:${signature.via}:${signature.key ?? ""}`
      if (seen.has(identity)) continue
      // A bare provider hit with no id is subsumed by a keyed one already recorded for it.
      if (signature.key === undefined && entries.some((entry) => entry.provider === signature.provider && entry.via === signature.via)) {
        continue
      }
      seen.add(identity)
      entries.push({
        provider: signature.provider,
        via: signature.via,
        file,
        line: lineNumberAt(contents, signature.offset),
        ...(signature.key !== undefined ? { key: signature.key } : {})
      })
    }
  }
  const order: ProviderId[] = ["ga4", "posthog", "x", "meta", "infinite"]
  return entries.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider))
}

/** Adapt main's `string[]` and the sibling branch's `{provider, via, file}[]` to one shape. */
export function normalizeDetected(raw: ReadonlyArray<string | DetectedProvider>): DetectedProvider[] {
  return raw.map((entry) =>
    typeof entry === "string"
      ? { provider: entry as ProviderId, via: "snippet" as const, file: "?" }
      : { provider: entry.provider, via: entry.via, file: entry.file }
  )
}

// ---------------------------------------------------------------------------------------------
// .env keys
// ---------------------------------------------------------------------------------------------

export interface EnvKeyHit {
  value: string
  /** Root-relative env file the value came from. Never the value in a report. */
  file: string
}

export interface EnvKeys {
  ga4MeasurementId?: EnvKeyHit
  posthogProjectKey?: EnvKeyHit
  posthogApiHost?: EnvKeyHit
  metaPixelId?: EnvKeyHit
  xPixelId?: EnvKeyHit
  infiniteSiteSourceKey?: EnvKeyHit
}

/** Real env files, in override order (later wins). Templates are deliberately absent. */
export const ENV_FILES = [".env", ".env.production", ".env.local", ".env.production.local"] as const
export const ENV_TEMPLATE_FILES = [".env.example", ".env.sample", ".env.template", ".env.dist"] as const

const ENV_NAMES: Record<keyof EnvKeys, readonly string[]> = {
  ga4MeasurementId: [
    "NEXT_PUBLIC_GA_MEASUREMENT_ID",
    "NEXT_PUBLIC_GA4_MEASUREMENT_ID",
    "NEXT_PUBLIC_GA_ID",
    "VITE_GA_MEASUREMENT_ID",
    "VITE_GA4_MEASUREMENT_ID",
    "PUBLIC_GA_MEASUREMENT_ID",
    "GA4_MEASUREMENT_ID",
    "GA_MEASUREMENT_ID"
  ],
  posthogProjectKey: [
    "NEXT_PUBLIC_POSTHOG_KEY",
    "NEXT_PUBLIC_POSTHOG_PROJECT_KEY",
    "VITE_POSTHOG_KEY",
    "PUBLIC_POSTHOG_KEY",
    "POSTHOG_PROJECT_KEY",
    "POSTHOG_KEY"
  ],
  posthogApiHost: ["NEXT_PUBLIC_POSTHOG_HOST", "VITE_POSTHOG_HOST", "PUBLIC_POSTHOG_HOST", "POSTHOG_HOST"],
  metaPixelId: [
    "NEXT_PUBLIC_META_PIXEL_ID",
    "NEXT_PUBLIC_FB_PIXEL_ID",
    "NEXT_PUBLIC_FACEBOOK_PIXEL_ID",
    "VITE_META_PIXEL_ID",
    "META_PIXEL_ID",
    "FB_PIXEL_ID"
  ],
  xPixelId: ["NEXT_PUBLIC_X_PIXEL_ID", "NEXT_PUBLIC_TWITTER_PIXEL_ID", "VITE_X_PIXEL_ID", "X_PIXEL_ID"],
  infiniteSiteSourceKey: ["NEXT_PUBLIC_INFINITE_SITE_SOURCE_KEY", "VITE_INFINITE_SITE_SOURCE_KEY", "INFINITE_SITE_SOURCE_KEY"]
}

function parseEnvFile(contents: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === "" || line.startsWith("#")) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      const comment = value.indexOf(" #")
      if (comment >= 0) value = value.slice(0, comment).trim()
    }
    values.set(match[1], value)
  }
  return values
}

/**
 * Reads the public ids the project's REAL env files set. A key found only in a committed
 * template (.env.example and friends) is missing — a template documents a key rather than
 * setting it, and is never read here, let alone written.
 */
export function readEnvKeys(root: string, appRoot: string): EnvKeys {
  const directories = appRoot === "." || appRoot === "" ? ["."] : [".", appRoot]
  const found: EnvKeys = {}
  for (const directory of directories) {
    for (const envFile of ENV_FILES) {
      const relativePath = directory === "." ? envFile : `${directory}/${envFile}`
      const absolutePath = join(root, relativePath)
      if (!existsSync(absolutePath)) continue
      let values: Map<string, string>
      try {
        values = parseEnvFile(readFileSync(absolutePath, "utf8"))
      } catch {
        continue
      }
      for (const field of Object.keys(ENV_NAMES) as Array<keyof EnvKeys>) {
        for (const name of ENV_NAMES[field]) {
          const value = values.get(name)
          if (value !== undefined && value !== "") {
            found[field] = { value, file: relativePath }
            break
          }
        }
      }
    }
  }
  return found
}

// ---------------------------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------------------------

export interface ResolveHarnessKeysInput {
  /** Artifacts built from explicit flags / --artifact-file (`resolveWorkspaceArtifacts`). */
  flags: WorkspaceInstallArtifacts
  /** True when any explicit artifact input was given (flags win outright, like the tag CLI). */
  explicitFlags: boolean
  /** The file `infinite setup` saved (`discoverWorkspaceArtifacts`), if any. */
  discovered: WorkspaceInstallArtifacts | null
  env: EnvKeys
  detected: ReadonlyArray<DetectedProviderEvidence>
}

type KeyedProvider = Exclude<HarnessProviderId, "gtm" | "server_lane">

/**
 * Precedence per provider: explicit flags → saved artifacts → real .env files. Ids read from an
 * existing snippet are NOT promoted to install keys — a provider that already exists is adopted
 * and left alone; its id only fills the report's key column.
 */
export function resolveHarnessKeys(input: ResolveHarnessKeysInput): ResolvedKeys {
  const artifacts: WorkspaceInstallArtifacts = {}
  const sources: ResolvedKeys["sources"] = {}
  const take = (provider: KeyedProvider, value: WorkspaceInstallArtifacts[KeyedProvider] | undefined, source: KeySource): boolean => {
    if (value === undefined || artifacts[provider] !== undefined) return false
    ;(artifacts as Record<string, unknown>)[provider] = value
    sources[provider] = source
    return true
  }
  const providers: KeyedProvider[] = ["ga4", "posthog", "meta", "x", "infinite"]

  for (const provider of providers) {
    if (input.explicitFlags) take(provider, input.flags[provider], "flag")
  }
  if (input.flags.productionHosts) artifacts.productionHosts = input.flags.productionHosts
  for (const provider of providers) {
    take(provider, input.discovered?.[provider], "discovered-artifacts")
  }
  if (!artifacts.productionHosts && input.discovered?.productionHosts) {
    artifacts.productionHosts = input.discovered.productionHosts
  }

  const env = input.env
  if (env.ga4MeasurementId && validateGa4MeasurementId(env.ga4MeasurementId.value) === null) {
    take("ga4", { measurementId: env.ga4MeasurementId.value }, "env")
  }
  if (env.posthogProjectKey && validatePosthogProjectKey(env.posthogProjectKey.value) === null) {
    take(
      "posthog",
      { projectKey: env.posthogProjectKey.value, apiHost: env.posthogApiHost?.value ?? "https://us.i.posthog.com" },
      "env"
    )
  }
  if (env.metaPixelId && validateMetaPixelId(env.metaPixelId.value) === null) {
    take("meta", { pixelId: env.metaPixelId.value }, "env")
  }
  if (env.xPixelId && validateXPixelId(env.xPixelId.value) === null) {
    take("x", { pixelId: env.xPixelId.value, eventTagIds: [] }, "env")
  }
  if (env.infiniteSiteSourceKey && validateInfiniteSiteSourceKey(env.infiniteSiteSourceKey.value) === null) {
    take(
      "infinite",
      {
        siteSourceKey: env.infiniteSiteSourceKey.value,
        collectPath: DEFAULT_INFINITE_COLLECT_PATH,
        productionHosts: artifacts.productionHosts ?? []
      },
      "env"
    )
  }
  return { artifacts, sources }
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

export interface ClassifyProvidersInput {
  manifest: Pick<InstallManifest, "providers" | "serverLane"> | null
  detected: ReadonlyArray<DetectedProviderEvidence>
  keys: ResolvedKeys
  adoptExisting: boolean
  serverLane: boolean
  /** `--providers` restriction; undefined = every resolvable provider. */
  requested?: ReadonlyArray<HarnessProviderId>
}

function publicKey(artifacts: WorkspaceInstallArtifacts, provider: KeyedProvider): string | undefined {
  switch (provider) {
    case "ga4":
      return artifacts.ga4?.measurementId || undefined
    case "posthog":
      return artifacts.posthog?.projectKey || undefined
    case "meta":
      return artifacts.meta?.pixelId || undefined
    case "x":
      return artifacts.x?.pixelId || undefined
    case "infinite":
      return artifacts.infinite?.siteSourceKey || undefined
  }
}

/**
 * `absent → install` / `unmanaged → adopt` / `managed → upgrade` / `gtm → manual` /
 * `conflict → report`. Exactly one action per provider, always with a one-clause reason.
 */
export function classifyProviders(input: ClassifyProvidersInput): ProviderClassification[] {
  const wanted = (provider: HarnessProviderId): boolean =>
    input.requested === undefined || input.requested.includes(provider)
  const container = input.detected.find((entry) => entry.provider === "ga4" && entry.via === "gtm")
  const out: ProviderClassification[] = []

  for (const provider of HARNESS_PROVIDER_ORDER) {
    if (provider === "gtm") {
      out.push(
        container
          ? {
              provider,
              action: "manual",
              reason: "Tag Manager container found; GA4 is presumed container-owned. Add tags in GTM, not here.",
              file: container.file,
              ...(container.key ? { key: container.key } : {})
            }
          : { provider, action: "skip", reason: "no Tag Manager container found" }
      )
      continue
    }
    if (provider === "server_lane") {
      if (!input.serverLane) {
        out.push({ provider, action: "skip", reason: "not requested (pass --server-lane)" })
      } else if (input.manifest?.serverLane) {
        out.push({ provider, action: "upgrade", reason: "server lane already recorded in .infinite/install.json" })
      } else {
        out.push({ provider, action: "install", reason: "requested with --server-lane" })
      }
      continue
    }

    const keyed = provider as KeyedProvider
    if (!wanted(keyed)) {
      out.push({ provider, action: "skip", reason: "not in --providers" })
      continue
    }
    const existing = input.detected.filter((entry) => entry.provider === keyed && entry.via === "snippet")
    const distinctKeys = [...new Set(existing.map((entry) => entry.key).filter((key): key is string => key !== undefined))]
    const managed = input.manifest?.providers.includes(keyed) ?? false
    const key = publicKey(input.keys.artifacts, keyed)

    if (distinctKeys.length > 1) {
      out.push({
        provider,
        action: "report",
        reason: `conflict: ${distinctKeys.length} different ids found (${distinctKeys.join(", ")}); nothing installed`,
        file: existing[0].file,
        key: distinctKeys[0]
      })
      continue
    }
    if (managed && existing.length > 0) {
      out.push({
        provider,
        action: "report",
        reason: `conflict: managed by .infinite/install.json AND an unmanaged snippet in ${existing[0].file}`,
        file: existing[0].file,
        ...(existing[0].key ? { key: existing[0].key } : {})
      })
      continue
    }
    if (existing.length > 0) {
      const first = existing[0]
      out.push(
        input.adoptExisting
          ? {
              provider,
              action: "adopt",
              reason: `existing snippet in ${first.file}:${first.line} left byte-for-byte alone`,
              file: first.file,
              ...(first.key ? { key: first.key } : {})
            }
          : {
              provider,
              action: "report",
              reason: `existing unmanaged snippet in ${first.file}:${first.line}; --no-adopt-existing refuses to install beside it`,
              file: first.file,
              ...(first.key ? { key: first.key } : {})
            }
      )
      continue
    }
    if (keyed === "ga4" && container) {
      out.push({
        provider,
        action: "adopt",
        reason: `presumed served by the Tag Manager container in ${container.file}; no second gtag installed`,
        file: container.file,
        ...(container.key ? { key: container.key } : {})
      })
      continue
    }
    if (managed) {
      out.push(
        key
          ? { provider, action: "upgrade", reason: "already installed by infinite-tag (.infinite/install.json); re-planned against the current key", key }
          : { provider, action: "skip", reason: "already installed by infinite-tag (.infinite/install.json); no key resolved to re-plan it", file: ".infinite/install.json" }
      )
      continue
    }
    if (key) {
      out.push({ provider, action: "install", reason: `no existing install; key from ${input.keys.sources[keyed] ?? "artifacts"}`, key })
      continue
    }
    out.push({ provider, action: "skip", reason: "no key resolved (flags, saved artifacts, or .env)" })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export interface BuildHarnessPlanInput {
  root: string
  inspect: InspectResult
  classifications: ReadonlyArray<ProviderClassification>
  keys: ResolvedKeys
  workspaceId?: string
  serverLane: boolean
}

export interface HarnessPlanResult {
  plan: InstallPlan
  /** True when no provider installs/upgrades and no server lane was asked for. */
  nothingToInstall: boolean
  failure?: { code: HarnessFailureCode; message: string }
}

const NO_ARTIFACTS_BLOCKER = "No supported public install artifacts were provided."

/** The artifacts the plan will WRITE: only providers classified install/upgrade. */
export function plannedArtifacts(
  classifications: ReadonlyArray<ProviderClassification>,
  keys: ResolvedKeys
): WorkspaceInstallArtifacts {
  const artifacts: WorkspaceInstallArtifacts = {}
  if (keys.artifacts.productionHosts) artifacts.productionHosts = keys.artifacts.productionHosts
  for (const entry of classifications) {
    if (entry.action !== "install" && entry.action !== "upgrade") continue
    if (entry.provider === "gtm" || entry.provider === "server_lane") continue
    const value = keys.artifacts[entry.provider]
    if (value !== undefined) (artifacts as Record<string, unknown>)[entry.provider] = value
  }
  return artifacts
}

export function buildHarnessPlan(input: BuildHarnessPlanInput): HarnessPlanResult {
  const artifacts = plannedArtifacts(input.classifications, input.keys)
  const plan = planInstallation({
    root: input.root,
    inspect: input.inspect,
    workspaceId: input.workspaceId,
    artifacts,
    serverLane: input.serverLane
  })
  const nothingToInstall = plan.providers.length === 0 && !input.serverLane
  const blockers = plan.blockers.filter((blocker) => !(nothingToInstall && blocker === NO_ARTIFACTS_BLOCKER))
  if (nothingToInstall) {
    plan.blockers = blockers
  }
  if (blockers.length === 0) {
    return { plan, nothingToInstall }
  }
  const unmanaged = blockers.find((blocker) => /unmanaged|not managed by Infinite/i.test(blocker))
  return {
    plan,
    nothingToInstall,
    failure: unmanaged
      ? { code: "INF_PLAN_UNMANAGED_TARGET", message: unmanaged }
      : { code: "INF_PLAN_BLOCKED", message: blockers.join(" ") }
  }
}
