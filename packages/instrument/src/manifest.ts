import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  assertConfinedManifestFileEntry,
  resolveConfinedAppRoot,
  writeFileAtomic
} from "./frameworks/shared.js"
import { isEditRecordShape } from "./install/edits.js"
import { providerInstallEvidence } from "./provider-evidence.js"
import { SERVER_LANE_SECRET_ENV, SERVER_LANE_SOURCE_KEY_ENV } from "./server-lane/helpers.js"
import type { InstallManifest, ProviderId, SupportedFramework } from "./types.js"
import type { InstallManifestIds } from "./wizard/contracts/jobs.js"

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
  // uninstall rewrites (or removes) every recorded edit's file: confined like every other path.
  for (const edit of manifest.edits ?? []) {
    assertConfinedManifestFileEntry(root, edit.file)
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
    (candidate.serverLane === undefined || isServerLaneManifestShape(candidate.serverLane)) &&
    (candidate.edits === undefined || (Array.isArray(candidate.edits) && candidate.edits.every(isEditRecordShape))) &&
    (candidate.ids === undefined || isManifestIdsShape(candidate.ids)) &&
    (candidate.browserTag === undefined || candidate.browserTag === true)
  )
}

const stringArray = (value: unknown): boolean => Array.isArray(value) && value.every((entry) => typeof entry === "string")

/** §3e.6 `ids`: `{ga4: string[], posthog: {projectKey, apiHost} | null, meta: string[], infinite: {siteSourceKey} | null}`. */
function isManifestIdsShape(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const ids = value as Record<string, unknown>
  // The four §3e.6 tools must be there; a newer tag's extra fields are tolerated (never "corrupt").
  if (!["ga4", "infinite", "meta", "posthog"].every((key) => key in ids)) return false
  const posthog = ids.posthog as Record<string, unknown> | null
  const infinite = ids.infinite as Record<string, unknown> | null
  return (
    stringArray(ids.ga4) &&
    stringArray(ids.meta) &&
    (posthog === null ||
      (typeof posthog === "object" &&
        typeof posthog.projectKey === "string" &&
        typeof posthog.apiHost === "string")) &&
    (infinite === null ||
      (typeof infinite === "object" && typeof infinite.siteSourceKey === "string"))
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

/** One receipt describes one app: a run for another app root or framework is refused before it writes anything. */
export function assertReceiptDescribesApp(
  previous: InstallManifest | null,
  run: Pick<InstallManifest, "appRoot" | "framework">
): void {
  if (!previous || (previous.appRoot === run.appRoot && previous.framework === run.framework)) return
  throw new Error(
    `Refusing to record this install: ${installManifestRelativePath} records a ${previous.framework} install at "${previous.appRoot}"; this run installs ${run.framework} at "${run.appRoot}". One receipt describes one app: uninstall the earlier install first (npx infinite-tag uninstall).`
  )
}

/** Which halves of the install THIS run planned, and so owns in the receipt it writes. */
export interface InstallReceiptScope {
  /** The browser tag (providers, its managed files, manual wiring) was planned and rendered. */
  browser: boolean
  /** The server lane was planned and written. */
  serverLane: boolean
  /**
   * Lane files this run's plan leaves to the customer (`manual`: their own file now sits there). An
   * earlier record of them is dropped, so uninstall never touches the customer's file.
   */
  laneDisowned?: readonly string[]
}

const SERVER_LANE_ENV_KEY_SET = new Set<string>([SERVER_LANE_SOURCE_KEY_ENV, SERVER_LANE_SECRET_ENV])

/**
 * ONE receipt per repo: a run merges what it did into the receipt already there, never replaces it.
 * (`install --server-lane` after the wizard's browser tag once replaced the tag's record, so uninstall
 * would have left the tag behind and doctor would have seen no tag.) The rules, the same ones the
 * wizard's re-runs follow (`WizardInstaller.writeReceipt` builds on the current receipt, its edits are
 * kept oldest first, its ids stand unless this run emits new ones):
 *
 *  - files, contentHashes, configOwnership: the union; this run's entry wins for every path it wrote.
 *    Earlier entries come first (stable, so an identical re-run writes nothing). The post-install check
 *    hash-verifies only this run's files (`managedFilesOfRun`): earlier entries are carried, not re-verified.
 *  - envKeys: each half's keys from the run that last planned that half (a dropped provider's keys go).
 *  - edits: kept in order, this run's new records appended (by id), so uninstall still walks them newest first.
 *  - providers, requiresManual: this run's when it planned the browser tag (what the page now carries),
 *    else the earlier receipt's.
 *  - ids: per tool, this run's id when it emitted one, else the earlier receipt's.
 *  - workspaceId: the earlier receipt's (the install that created the receipt).
 *  - runId, managedCapture: only the wizard writes them; kept unless this run carries its own.
 *  - browserTag: once the browser adapter wrote the tag, it stays recorded (uninstall runs its reversal).
 *  - serverLane: this run's when it planned the lane (its `created` files unioned with the earlier
 *    record's, minus any the plan now leaves to the customer), else the earlier receipt's.
 *
 * One receipt describes one app: a different app root or framework is refused, never silently merged.
 */
export function mergeInstallManifest(
  previous: InstallManifest | null,
  run: InstallManifest,
  scope: InstallReceiptScope
): InstallManifest {
  if (!previous) return run
  assertReceiptDescribesApp(previous, run)
  const browser = scope.browser ? run : previous
  const disowned = new Set(scope.laneDisowned ?? [])
  const kept = (path: string): boolean => !disowned.has(path)
  // This run's lane record, keeping every whole file an earlier run's lane record lists as created (the
  // wizard's server-events handoff is one): uninstall removes exactly what `created` lists.
  const laneCreated = [...new Set([...(previous.serverLane?.created ?? []), ...(run.serverLane?.created ?? [])])].filter(kept)
  const lane =
    scope.serverLane && run.serverLane
      ? { ...run.serverLane, ...(laneCreated.length > 0 ? { created: laneCreated } : {}) }
      : previous.serverLane
  const configOwnership = Object.fromEntries(
    Object.entries({ ...previous.configOwnership, ...run.configOwnership }).filter(([path]) => kept(path))
  )
  const contentHashes = Object.fromEntries(
    Object.entries({ ...previous.contentHashes, ...run.contentHashes }).filter(([path]) => kept(path))
  )
  const laneKeys = (manifest: InstallManifest) => manifest.envKeys.filter((key) => SERVER_LANE_ENV_KEY_SET.has(key))
  const browserKeys = (manifest: InstallManifest) => manifest.envKeys.filter((key) => !SERVER_LANE_ENV_KEY_SET.has(key))
  const envKeys = [
    ...new Set([
      ...browserKeys(scope.browser ? run : previous),
      ...laneKeys(scope.serverLane ? run : previous)
    ])
  ]
  const known = new Set((previous.edits ?? []).map((edit) => edit.id))
  const edits = [...(previous.edits ?? []), ...(run.edits ?? []).filter((edit) => !known.has(edit.id))]
  const ids = mergeIds(previous.ids, run.ids)
  const managedCapture = run.managedCapture ?? previous.managedCapture
  const runId = run.runId ?? previous.runId
  const browserTag = previous.browserTag === true || run.browserTag === true
  return {
    ...(managedCapture ? { managedCapture } : {}),
    workspaceId: previous.workspaceId,
    ...(runId ? { runId } : {}),
    appRoot: run.appRoot,
    framework: run.framework,
    ...(browserTag ? { browserTag: true as const } : {}),
    providers: browser.providers,
    files: [...new Set([...previous.files, ...run.files])].filter(kept),
    envKeys,
    contentHashes,
    ...(Object.keys(configOwnership).length > 0 ? { configOwnership } : {}),
    ...(lane ? { serverLane: lane } : {}),
    ...(browser.requiresManual && browser.requiresManual.length > 0 ? { requiresManual: browser.requiresManual } : {}),
    ...(edits.length > 0 ? { edits } : {}),
    ...(ids ? { ids } : {}),
    wiringVersion: run.wiringVersion,
    verifiedAt: run.verifiedAt
  }
}

/** Per tool: the id this run emitted, else the earlier receipt's. A run that emitted none changes nothing. */
function mergeIds(previous: InstallManifestIds | undefined, run: InstallManifestIds | undefined): InstallManifestIds | undefined {
  if (!run) return previous
  if (!previous) return run
  return {
    ...previous,
    ga4: run.ga4.length > 0 ? run.ga4 : previous.ga4,
    posthog: run.posthog ?? previous.posthog,
    meta: run.meta.length > 0 ? run.meta : previous.meta,
    infinite: run.infinite ?? previous.infinite
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

// ---------------------------------------------------------------------------------------------
// Rebuild from markers (a corrupt receipt, or one written by an incompatible version)
// ---------------------------------------------------------------------------------------------

/** The two markers every managed write carries: a whole managed file, and an injected HTML block. */
const MANAGED_FILE_MARKER = "Managed by Infinite"
const MANAGED_BLOCK_START = "<!-- infinite:start -->"
const MANAGED_BLOCK_END = "<!-- infinite:end -->"
const REBUILD_SKIPPED_DIRECTORIES = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".vercel", ".infinite", "coverage"])
const REBUILD_MAX_FILES = 5_000
const REBUILD_EXTENSIONS = /\.(html|htm|tsx|jsx|ts|js|mjs|cjs|json|astro|vue|svelte)$/

export interface RebuildManifestInput {
  root: string
  /** The app root `inspect` resolved (repo-root-relative). */
  appRoot: string
  /** The framework `inspect` detected; a rebuild never guesses one. */
  framework: SupportedFramework
  workspaceId: string
}

export interface RebuildManifestResult {
  manifest: InstallManifest
  /** Repo-root-relative files that carried a managed marker. */
  managedFiles: string[]
  /**
   * What a marker scan cannot recover, said plainly: the recorded edits (their exact reversal data
   * lived only in the receipt), config ownership, the server-lane record, the manual requirements.
   */
  lost: string[]
}

function walkForMarkers(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    if (files.length >= REBUILD_MAX_FILES) return
    let entries
    try {
      entries = readdirSync(join(root, directory), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= REBUILD_MAX_FILES) return
      const relativePath = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!REBUILD_SKIPPED_DIRECTORIES.has(entry.name)) visit(relativePath)
        continue
      }
      if (entry.isFile() && REBUILD_EXTENSIONS.test(entry.name)) files.push(relativePath)
    }
  }
  visit("")
  return files
}

/**
 * A minimal manifest rebuilt from the managed markers on disk: which files infinite-tag manages
 * (by marker, never by guess), their current hashes, and the providers the managed bytes install.
 * It never invents what it cannot read back: `lost` lists it, and the caller says so.
 */
export function rebuildInstallManifestFromMarkers(input: RebuildManifestInput): RebuildManifestResult {
  const managedFiles: string[] = []
  const providers = new Set<ProviderId>()
  for (const file of walkForMarkers(input.root)) {
    let contents: string
    try {
      contents = readFileSync(join(input.root, file), "utf8")
    } catch {
      continue
    }
    const wholeFile = contents.includes(MANAGED_FILE_MARKER)
    const block = contents.indexOf(MANAGED_BLOCK_START)
    if (!wholeFile && block < 0) continue
    managedFiles.push(file)
    const blockEnd = block < 0 ? -1 : contents.indexOf(MANAGED_BLOCK_END, block)
    const managedBytes = wholeFile ? contents : contents.slice(block, blockEnd < 0 ? undefined : blockEnd + MANAGED_BLOCK_END.length)
    for (const evidence of providerInstallEvidence(managedBytes)) providers.add(evidence.provider)
    if (/__infinite|infiniteAnalytics|\/infinite\/ledger/.test(managedBytes)) providers.add("infinite")
  }
  const order: ProviderId[] = ["infinite", "ga4", "posthog", "x", "meta"]
  return {
    manifest: {
      workspaceId: input.workspaceId,
      appRoot: input.appRoot,
      framework: input.framework,
      providers: order.filter((provider) => providers.has(provider)),
      files: managedFiles,
      envKeys: [],
      contentHashes: computeContentHashes(input.root, managedFiles),
      wiringVersion: 1,
      verifiedAt: null
    },
    managedFiles,
    lost: ["edits", "configOwnership", "serverLane", "requiresManual"]
  }
}

export type ReadOrRebuildResult =
  | { manifest: InstallManifest | null; rebuilt: false }
  | { manifest: InstallManifest; rebuilt: true; lost: string[] }

/**
 * Read the receipt; when it is corrupt and the caller allows it, rebuild it from the markers and
 * write the rebuilt one. Without `rebuild` a corrupt receipt still throws (never a silent reset).
 */
export function readInstallManifestOrRebuild(
  root: string,
  options: { rebuild: Omit<RebuildManifestInput, "root"> | null }
): ReadOrRebuildResult {
  try {
    return { manifest: readInstallManifest(root), rebuilt: false }
  } catch (error) {
    if (!options.rebuild || !(error instanceof Error) || !error.message.startsWith("Corrupt .infinite/install.json")) throw error
    const result = rebuildInstallManifestFromMarkers({ root, ...options.rebuild })
    writeInstallManifest(root, result.manifest)
    return { manifest: result.manifest, rebuilt: true, lost: result.lost }
  }
}
