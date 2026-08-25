/**
 * Shared builders for the PostHog reverse-proxy host config, used by BOTH Next adapters
 * (next.config.*) and BOTH Vercel-hosted adapters (vercel.json), so the rewrite logic lives
 * in ONE place and can't drift between them.
 *
 * Generated Next configs are content-hash owned. Existing Next configs are never edited; their
 * exact rewrites are statically proven before apply. Existing vercel.json files receive recorded
 * text insertions that can be reversed byte-for-byte without storing customer configuration.
 */
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import type {
  InfiniteProxySpec,
  InstallManifest,
  InstallInstruction,
  ManagedConfigOwnership,
  PosthogProxySpec
} from "../types.js"
import { computeContentHash } from "../manifest.js"
import { isManagedInfiniteFile, managedFileBanner } from "./managed-files.js"
import { firstExistingPath, normalizeAppRelativePath, writeFileIfChanged } from "./shared.js"

export const VERCEL_CONFIG_FILE = "vercel.json"

export const nextConfigCandidates = [
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "next.config.cjs"
]

/** The filename we CREATE when no next.config exists (unambiguously ESM, Next-supported). */
export const MANAGED_NEXT_CONFIG_FILE = "next.config.mjs"

export interface VercelRewrite {
  source: string
  destination: string
}

interface VercelConfig {
  rewrites?: unknown
  [key: string]: unknown
}

export interface ManagedProxySpec {
  posthog?: PosthogProxySpec
  infinite?: InfiniteProxySpec
}

type ProxyInput = PosthogProxySpec | ManagedProxySpec

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "")
}

/**
 * The ordered rewrite pairs — PostHog's official Vercel pattern (posthog.com/docs/advanced/proxy/vercel).
 * Order is LOAD-BEARING: the `/static/*` and `/array/*` assets rules must precede the catch-all so
 * Vercel/Next (top-down, most-specific-first) route array.js + remote config to the ASSETS host, not
 * the ingest host. Sources use `:path(.*)` (a regex that CAPTURES a trailing slash) NOT `:path*`
 * (segment-based — it does NOT match `/ingest/e/`, so a Vercel STATIC site falls through to missing-
 * directory resolution → `x-vercel-error: NOT_FOUND` → PostHog capture silently dies, since its
 * endpoints (`/e/`, `/i/v0/e/`, `/decide/`, `/flags/?v=2`) all use trailing slashes). The `/array/`
 * rule is separate because posthog-js fetches remote config from `/array/<token>/config`, served by
 * the assets host. The prefix comes from proxy.path, never a hardcoded `/ingest`.
 */
export function buildPosthogRewritePairs(proxy: PosthogProxySpec): VercelRewrite[] {
  const path = stripTrailingSlash(proxy.path)
  return [
    {
      source: `${path}/static/:path(.*)`,
      destination: `${proxy.assetsHost}/static/:path`
    },
    {
      source: `${path}/array/:path(.*)`,
      destination: `${proxy.assetsHost}/array/:path`
    },
    { source: `${path}/:path(.*)`, destination: `${proxy.ingestHost}/:path` }
  ]
}

export function buildInfiniteRewritePair(proxy: InfiniteProxySpec): VercelRewrite {
  return { source: proxy.path, destination: proxy.destination }
}

function managedProxySpec(input: ProxyInput): ManagedProxySpec {
  return "assetsHost" in input ? { posthog: input } : input
}

export function buildManagedRewritePairs(input: ProxyInput): VercelRewrite[] {
  const managed = managedProxySpec(input)
  return [
    ...(managed.posthog ? buildPosthogRewritePairs(managed.posthog) : []),
    ...(managed.infinite ? [buildInfiniteRewritePair(managed.infinite)] : [])
  ]
}

function serialize(config: VercelConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** Parse an existing vercel.json, REFUSING (clear error) if it isn't a JSON object. */
export function parseVercelConfig(source: string): VercelConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(
      `Refusing to modify vercel.json because it is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Refusing to modify vercel.json because it is not a JSON object.")
  }
  return parsed as VercelConfig
}

/** Fresh vercel.json (create case) carrying only the managed rewrites. */
export function buildVercelJson(proxy: ProxyInput): string {
  return serialize({ rewrites: buildManagedRewritePairs(proxy) })
}

function asRewriteArray(value: unknown): VercelRewrite[] {
  return Array.isArray(value) ? (value as VercelRewrite[]) : []
}

/**
 * Merge our rewrites into an existing parsed vercel.json (replace-in-place by exact `source`,
 * else append), preserving every other entry and top-level key. Idempotent: a re-merge produces
 * a byte-identical serialization (stable key order + trailing newline). REFUSES if a same-source
 * entry already points at a non-PostHog destination (the consumer uses that path for something
 * else) — no silent clobber.
 */
export function mergeVercelRewrites(existing: VercelConfig, proxy: ProxyInput): string {
  const pairs = buildManagedRewritePairs(proxy)
  const ourSources = new Set(pairs.map((pair) => pair.source))
  const current = asRewriteArray(existing.rewrites)

  for (const rewrite of current) {
    if (
      rewrite &&
      typeof rewrite === "object" &&
      ourSources.has(rewrite.source) &&
      !isManagedDestination(rewrite.source, rewrite.destination, pairs)
    ) {
      throw new Error(
        `Refusing to modify vercel.json: a rewrite for ${JSON.stringify(rewrite.source)} already points at an unmanaged destination (${JSON.stringify(rewrite.destination)}). Resolve it manually, then re-run.`
      )
    }
  }

  const merged: VercelRewrite[] = []
  const placed = new Set<string>()
  for (const rewrite of current) {
    if (rewrite && typeof rewrite === "object" && ourSources.has(rewrite.source)) {
      const replacement = pairs.find((pair) => pair.source === rewrite.source)
      if (replacement && !placed.has(replacement.source)) {
        merged.push(replacement)
        placed.add(replacement.source)
      }
      continue
    }
    merged.push(rewrite)
  }
  for (const pair of pairs) {
    if (!placed.has(pair.source)) {
      merged.push(pair)
      placed.add(pair.source)
    }
  }

  return serialize({ ...existing, rewrites: merged })
}

export interface PruneVercelResult {
  /** true → the file collapsed to empty; the caller should DELETE it. */
  collapsed: boolean
  /** serialized remainder to write back (present only when not collapsed). */
  contents?: string
}

/**
 * Structural reversal: drop ONLY the rewrite entries we recognize (our source + a
 * *.i.posthog.com destination), keep everything else, and signal `collapsed` when the object
 * has no keys left so the caller deletes the file rather than leaving an empty `{}`.
 */
export function pruneVercelRewrites(existing: VercelConfig, proxy: ProxyInput): PruneVercelResult {
  const pairs = buildManagedRewritePairs(proxy)
  const ourSources = new Set(pairs.map((pair) => pair.source))
  const current = asRewriteArray(existing.rewrites)
  const remaining = current.filter(
    (rewrite) =>
      !(
        rewrite &&
        typeof rewrite === "object" &&
        ourSources.has(rewrite.source) &&
        isManagedDestination(rewrite.source, rewrite.destination, pairs)
      )
  )

  const next: VercelConfig = { ...existing }
  if (remaining.length > 0) {
    next.rewrites = remaining
  } else {
    delete next.rewrites
  }

  if (Object.keys(next).length === 0) {
    return { collapsed: true }
  }
  return { collapsed: false, contents: serialize(next) }
}

/** Read + parse an existing vercel.json (null when absent; throws when unparseable). */
export function readVercelConfig(root: string): VercelConfig | null {
  const absolutePath = join(root, VERCEL_CONFIG_FILE)
  if (!existsSync(absolutePath)) {
    return null
  }
  return parseVercelConfig(readFileSync(absolutePath, "utf8"))
}

/** The contents to write for vercel.json — a fresh file if absent, else the merged one. */
export function resolveVercelJsonContents(root: string, proxy: ProxyInput): string {
  const existing = readVercelConfig(root)
  return existing ? mergeVercelRewrites(existing, proxy) : buildVercelJson(proxy)
}

export interface ManagedConfigApplyResult {
  path: string
  changed: boolean
  ownership?: ManagedConfigOwnership
}

export function appRelativeConfigOwnership(
  manifest: InstallManifest | null,
  appRoot: string
): Record<string, ManagedConfigOwnership> | undefined {
  if (!manifest?.configOwnership) return undefined
  const prefix = appRoot === "." ? "" : `${appRoot}/`
  return Object.fromEntries(
    Object.entries(manifest.configOwnership)
      .filter(([path]) => prefix === "" || path.startsWith(prefix))
      .map(([path, ownership]) => [prefix === "" ? path : path.slice(prefix.length), ownership])
  )
}

export function applyManagedVercelJson(params: {
  appRootAbsolute: string
  proxy: ProxyInput
  previousOwnership?: ManagedConfigOwnership
}): ManagedConfigApplyResult {
  const absolutePath = join(params.appRootAbsolute, VERCEL_CONFIG_FILE)
  const current = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null

  if (current === null) {
    const contents = buildVercelJson(params.proxy)
    const changed = writeFileIfChanged(params.appRootAbsolute, VERCEL_CONFIG_FILE, contents)
    return {
      path: VERCEL_CONFIG_FILE,
      changed,
      ownership: {
        kind: "created",
        installedHash: computeContentHash(contents)
      }
    }
  }

  const previous = params.previousOwnership
  if (previous && previous.installedHash !== computeContentHash(current)) {
    throw new Error(
      "Refusing to modify vercel.json because it changed after Infinite recorded its ownership hash."
    )
  }

  if (previous?.kind === "created") {
    const contents = buildVercelJson(params.proxy)
    const changed = writeFileIfChanged(params.appRootAbsolute, VERCEL_CONFIG_FILE, contents)
    return {
      path: VERCEL_CONFIG_FILE,
      changed,
      ownership: {
        kind: "created",
        installedHash: computeContentHash(contents)
      }
    }
  }

  const original =
    previous?.kind === "vercel-json-insertions"
      ? restoreOwnedVercelInsertions(current, previous, "modify")
      : current
  const patched = insertVercelRewritePairs(original, params.proxy)
  const insertions = patched.insertion ? [patched.insertion] : []
  const ownership: ManagedConfigOwnership = {
    kind: "vercel-json-insertions",
    originalHash:
      previous?.kind === "vercel-json-insertions"
        ? previous.originalHash
        : computeContentHash(original),
    installedHash: computeContentHash(patched.contents),
    insertions
  }
  return {
    path: VERCEL_CONFIG_FILE,
    changed: writeFileIfChanged(params.appRootAbsolute, VERCEL_CONFIG_FILE, patched.contents),
    ownership
  }
}

function restoreOwnedVercelInsertions(
  installed: string,
  ownership: Extract<ManagedConfigOwnership, { kind: "vercel-json-insertions" }>,
  operation: "modify" | "uninstall"
): string {
  let restored = installed
  for (const insertion of [...ownership.insertions].reverse()) {
    if (
      restored.slice(insertion.offset, insertion.offset + insertion.text.length) !==
      insertion.text
    ) {
      throw new Error(
        `Refusing to ${operation} vercel.json because an installer-owned insertion no longer matches.`
      )
    }
    restored =
      restored.slice(0, insertion.offset) +
      restored.slice(insertion.offset + insertion.text.length)
  }
  if (computeContentHash(restored) !== ownership.originalHash) {
    throw new Error(
      `Refusing to ${operation} vercel.json because reversing owned insertions did not restore the original hash.`
    )
  }
  return restored
}

function insertVercelRewritePairs(
  source: string,
  proxy: ProxyInput
): { contents: string; insertion?: { offset: number; text: string } } {
  const parsed = parseVercelConfig(source)
  if (parsed.rewrites !== undefined && !Array.isArray(parsed.rewrites)) {
    throw new Error("Refusing to modify vercel.json because rewrites is not an array.")
  }
  const current = asRewriteArray(parsed.rewrites)
  const pairs = buildManagedRewritePairs(proxy)
  for (const pair of pairs) {
    const sameSource = current.find(
      (rewrite) => rewrite && typeof rewrite === "object" && rewrite.source === pair.source
    )
    if (sameSource && sameSource.destination !== pair.destination) {
      throw new Error(
        `Refusing to modify vercel.json: a rewrite for ${JSON.stringify(pair.source)} already points at an unmanaged destination (${JSON.stringify(sameSource.destination)}). Resolve it manually, then re-run.`
      )
    }
  }
  const missing = pairs.filter(
    (pair) =>
      !current.some(
        (rewrite) => rewrite.source === pair.source && rewrite.destination === pair.destination
      )
  )
  if (missing.length === 0) return { contents: source }

  const location = locateTopLevelRewrites(source)
  const eol = source.includes("\r\n") ? "\r\n" : "\n"
  const compactPairs = missing.map((pair) => JSON.stringify(pair)).join(`,${eol}    `)
  let offset: number
  let text: string
  if (location) {
    const content = source.slice(location.arrayOpen + 1, location.arrayClose)
    const trailingWhitespace = content.match(/\s*$/)?.[0].length ?? 0
    offset = location.arrayClose - trailingWhitespace
    const hasElements = content.trim().length > 0
    text = hasElements ? `,${eol}    ${compactPairs}` : `${eol}    ${compactPairs}${eol}  `
  } else {
    const rootClose = findRootObjectClose(source)
    const beforeClose = source.slice(0, rootClose)
    const trailingWhitespace = beforeClose.match(/\s*$/)?.[0].length ?? 0
    offset = rootClose - trailingWhitespace
    const hasProperties = Object.keys(parsed).length > 0
    text = `${hasProperties ? "," : ""}${eol}  "rewrites": [${eol}    ${compactPairs}${eol}  ]`
  }
  return {
    contents: source.slice(0, offset) + text + source.slice(offset),
    insertion: { offset, text }
  }
}

function locateTopLevelRewrites(source: string): { arrayOpen: number; arrayClose: number } | null {
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '"') {
      const end = scanJsonString(source, index)
      if (depth === 1) {
        const key = JSON.parse(source.slice(index, end + 1)) as string
        let cursor = skipWhitespace(source, end + 1)
        if (key === "rewrites" && source[cursor] === ":") {
          cursor = skipWhitespace(source, cursor + 1)
          if (source[cursor] !== "[") return null
          return {
            arrayOpen: cursor,
            arrayClose: findMatchingJsonBracket(source, cursor)
          }
        }
      }
      index = end
      continue
    }
    if (character === "{") depth += 1
    if (character === "}") depth -= 1
  }
  return null
}

function scanJsonString(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === "\\") {
      index += 1
    } else if (source[index] === '"') {
      return index
    }
  }
  throw new Error("Refusing to modify vercel.json because it contains an unterminated string.")
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/.test(source[index] ?? "")) index += 1
  return index
}

function findMatchingJsonBracket(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '"') {
      index = scanJsonString(source, index)
      continue
    }
    if (source[index] === "[") depth += 1
    if (source[index] === "]") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new Error("Refusing to modify vercel.json because rewrites is not a complete array.")
}

function findRootObjectClose(source: string): number {
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (source[index] === "}") return index
  }
  throw new Error("Refusing to modify vercel.json because it is not a JSON object.")
}

export function applyManagedNextConfig(params: {
  appRootAbsolute: string
  proxy: ProxyInput
  previousOwnership?: Record<string, ManagedConfigOwnership>
}): ManagedConfigApplyResult {
  const existingPaths = nextConfigCandidates.filter((candidate) =>
    existsSync(join(params.appRootAbsolute, candidate))
  )
  if (existingPaths.length > 1) {
    throw new Error(
      `Refusing to choose between multiple Next configs: ${existingPaths.join(", ")}.`
    )
  }
  const existing = existingPaths[0] ?? null
  if (existing) {
    const current = readFileSync(join(params.appRootAbsolute, existing), "utf8")
    if (!isManagedInfiniteFile(current)) {
      if (hasExactNextConfigRewrites(current, params.proxy)) {
        return { path: existing, changed: false }
      }
      throw new Error(`Refusing to overwrite existing unmanaged ${existing}.`)
    }
    const previous = params.previousOwnership?.[existing]
    if (previous?.kind !== "created" || previous.installedHash !== computeContentHash(current)) {
      throw new Error(
        `Refusing to modify ${existing} because its ownership hash is missing or the file changed after installation.`
      )
    }
  }

  const path = existing ?? MANAGED_NEXT_CONFIG_FILE
  const contents = buildNextConfigSource(params.proxy)
  return {
    path,
    changed: writeFileIfChanged(params.appRootAbsolute, path, contents),
    ownership: { kind: "created", installedHash: computeContentHash(contents) }
  }
}

export interface VercelReversal {
  removedFiles: string[]
  restoredFiles: string[]
  warnings: string[]
}

/**
 * Hash-gated reversal shared by the Vite and static adapters. Created files are deleted; merged
 * files have only their recorded insertions removed, then must match the pre-install hash.
 */
export function reverseManagedVercelJson(params: {
  manifestFiles: string[]
  ownership?: ManagedConfigOwnership
  appRootAbsolute: string
  appRootRelative: string
  dryRun: boolean
}): VercelReversal {
  const result: VercelReversal = {
    removedFiles: [],
    restoredFiles: [],
    warnings: []
  }

  const managesVercel = params.manifestFiles.some(
    (file) => file === VERCEL_CONFIG_FILE || file.endsWith(`/${VERCEL_CONFIG_FILE}`)
  )
  if (!managesVercel) {
    return result
  }

  const vercelAbsolutePath = join(params.appRootAbsolute, VERCEL_CONFIG_FILE)
  if (!existsSync(vercelAbsolutePath)) {
    result.warnings.push(`Managed file already absent: ${VERCEL_CONFIG_FILE}`)
    return result
  }

  const currentRaw = readFileSync(vercelAbsolutePath, "utf8")
  if (!params.ownership || params.ownership.installedHash !== computeContentHash(currentRaw)) {
    throw new Error(
      "Refusing to uninstall vercel.json because its ownership hash is missing or the file changed after installation."
  )
  }
  const rootRelative = normalizeAppRelativePath(params.appRootRelative, VERCEL_CONFIG_FILE)
  if (params.ownership.kind === "created") {
    if (!params.dryRun) {
      rmSync(vercelAbsolutePath)
    }
    result.removedFiles.push(rootRelative)
  } else if (params.ownership.kind === "vercel-json-insertions") {
    const restored = restoreOwnedVercelInsertions(currentRaw, params.ownership, "uninstall")
    if (!params.dryRun) {
      writeFileIfChanged(params.appRootAbsolute, VERCEL_CONFIG_FILE, restored)
    }
    result.restoredFiles.push(rootRelative)
  } else {
    throw new Error("Refusing to uninstall vercel.json because its ownership record has an unexpected kind.")
  }

  return result
}

export function reverseManagedNextConfig(params: {
  manifest: InstallManifest
  appRootAbsolute: string
  appRootRelative: string
  dryRun: boolean
}): VercelReversal {
  const result: VercelReversal = {
    removedFiles: [],
    restoredFiles: [],
    warnings: []
  }
  const appPrefix = params.appRootRelative === "." ? "" : `${params.appRootRelative}/`
  const ownedConfigs = Object.entries(params.manifest.configOwnership ?? {}).filter(([path]) => {
    const appRelative =
      appPrefix === "" ? path : path.startsWith(appPrefix) ? path.slice(appPrefix.length) : ""
    return nextConfigCandidates.includes(appRelative)
  })
  if (ownedConfigs.length === 0) return result
  if (ownedConfigs.length > 1) {
    throw new Error("Refusing to uninstall multiple generated Next configs from one manifest.")
  }
  const [rootRelative, ownership] = ownedConfigs[0]!
  const existing = appPrefix === "" ? rootRelative : rootRelative.slice(appPrefix.length)
  const absolutePath = join(params.appRootAbsolute, existing)
  if (!existsSync(absolutePath)) {
    result.warnings.push(`Managed file already absent: ${existing}`)
    return result
  }
  const current = readFileSync(absolutePath, "utf8")
  if (
    !isManagedInfiniteFile(current) ||
    ownership?.kind !== "created" ||
    ownership.installedHash !== computeContentHash(current)
  ) {
    throw new Error(
      `Refusing to uninstall ${existing} because its ownership hash is missing or the generated file changed after installation.`
    )
  }
  if (!params.dryRun) rmSync(absolutePath)
  result.removedFiles.push(rootRelative)
  return result
}

/** Fresh next.config.mjs (create case), stamped with the managed banner as line 1. */
export function buildNextConfigSource(proxy: ProxyInput): string {
  const rewriteLiterals = buildManagedRewritePairs(proxy)
    .map(
      (pair) =>
        `      { source: ${JSON.stringify(pair.source)}, destination: ${JSON.stringify(pair.destination)} }`
    )
    .join(",\n")
  return [
    managedFileBanner,
    "",
    "export default {",
    "  async rewrites() {",
    "    return [",
    rewriteLiterals,
    "    ]",
    "  }",
    "}",
    ""
  ].join("\n")
}

/** Human-readable snippet for the "add these to your existing next.config" manual instruction. */
function buildManualNextConfigInstruction(proxy: ProxyInput): string {
  const rewriteLiterals = buildManagedRewritePairs(proxy)
    .map(
      (pair) =>
        `      { source: ${JSON.stringify(pair.source)}, destination: ${JSON.stringify(pair.destination)} }`
    )
    .join(",\n")
  return [
    "Add these rewrites to your existing next.config's async rewrites():",
    "",
    "    return [",
    rewriteLiterals,
    "    ]"
  ].join("\n")
}

export interface NextConfigProxyPlan {
  files: string[]
  instructions: InstallInstruction[]
  blockers: string[]
}

/**
 * Create a hash-owned config when absent, validate ownership on reapply, or statically prove that
 * an unmanaged config already contains every exact rewrite. Unproven configs remain plan-only.
 */
export function planNextConfigProxy(
  root: string,
  proxy: ProxyInput,
  ownership?: Record<string, ManagedConfigOwnership>
): NextConfigProxyPlan {
  const existingPaths = nextConfigCandidates.filter((candidate) =>
    existsSync(join(root, candidate))
  )
  if (existingPaths.length > 1) {
    return {
      files: [],
      instructions: [],
      blockers: [
        `Refusing to choose between multiple Next configs: ${existingPaths.join(", ")}. Keep one active config, then re-run.`
      ]
    }
  }
  const existing = existingPaths[0] ?? null
  const source = existing ? readFileSync(join(root, existing), "utf8") : null
  const existingIsManaged = source !== null && isManagedInfiniteFile(source)

  if (existing && existingIsManaged) {
    const expected = ownership?.[existing]
    if (expected?.kind !== "created" || expected.installedHash !== computeContentHash(source!)) {
      return {
        files: [existing],
        instructions: [],
        blockers: [
          `Refusing to trust ${existing}: its generated-file ownership hash is missing or the file changed after installation.`
        ]
      }
    }
  }

  if (existing && !existingIsManaged) {
    if (hasExactNextConfigRewrites(source!, proxy)) {
      return { files: [], instructions: [], blockers: [] }
    }
    return {
      files: [],
      instructions: [
        {
          path: existing,
          action: "modify",
          description: `Add the managed analytics rewrites to your existing ${existing} manually.`,
          snippet: buildManualNextConfigInstruction(proxy)
        }
      ],
      blockers: [
        `infinite-tag will not edit your existing ${existing}. Add the managed analytics rewrites shown in the plan to its async rewrites(), then re-run.`
      ]
    }
  }

  const targetPath = existing ?? MANAGED_NEXT_CONFIG_FILE
  return {
    files: [targetPath],
    instructions: [
      {
        path: targetPath,
        action: "create",
        description: `Create ${targetPath} with the managed analytics rewrites.`,
        snippet: buildNextConfigSource(proxy)
      }
    ],
    blockers: []
  }
}

interface JsToken {
  kind: "identifier" | "string" | "punctuation"
  value: string
}

export function hasExactNextConfigRewrites(source: string, proxy: ProxyInput): boolean {
  const tokens = tokenizeNextConfig(source)
  if (!tokens) return false
  const declarations = declaredObjectExpressions(tokens)
  const exportedObjects: number[] = []
  const exportedNames: string[] = []
  let commonJsExportsReferences = 0

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "export" && tokens[index + 1]?.value === "default") {
      const expression = tokens[index + 2]
      if (expression?.value === "{") exportedObjects.push(index + 2)
      else if (expression?.kind === "identifier") {
        const declared = declarations.get(expression.value)
        if (declared !== undefined) {
          exportedObjects.push(declared)
          exportedNames.push(expression.value)
        }
      }
    }
    const isCommonJsExports =
      tokens[index]?.value === "module" &&
      tokens[index + 1]?.value === "." &&
      tokens[index + 2]?.value === "exports"
    if (isCommonJsExports) commonJsExportsReferences += 1
    if (isCommonJsExports && tokens[index + 3]?.value === "=") {
      const expression = tokens[index + 4]
      if (expression?.value === "{") exportedObjects.push(index + 4)
      else if (expression?.kind === "identifier") {
        const declared = declarations.get(expression.value)
        if (declared !== undefined) {
          exportedObjects.push(declared)
          exportedNames.push(expression.value)
        }
      }
    }
  }

  if (exportedObjects.length !== 1) return false
  if (commonJsExportsReferences > 1) return false
  if (
    exportedNames.some(
      (name) => tokens.filter((token) => token.kind === "identifier" && token.value === name).length !== 2
    )
  ) {
    return false
  }
  const actual = literalRewritesFromConfig(tokens, exportedObjects[0]!)
  if (!actual) return false
  const expected = buildManagedRewritePairs(proxy)
  return (
    expected.every((pair) =>
      actual.some(
        (candidate) =>
          candidate.source === pair.source && candidate.destination === pair.destination
      )
    ) &&
    expected.every(
      (pair) =>
        !actual.some(
          (candidate) =>
            candidate.source === pair.source && candidate.destination !== pair.destination
        )
    )
  )
}

function tokenizeNextConfig(source: string): JsToken[] | null {
  const tokens: JsToken[] = []
  for (let index = 0; index < source.length; ) {
    const character = source[index]!
    if (/\s/.test(character)) {
      index += 1
      continue
    }
    if (source.startsWith("//", index)) {
      index = source.indexOf("\n", index + 2)
      if (index === -1) break
      continue
    }
    if (source.startsWith("/*", index)) {
      index = source.indexOf("*/", index + 2)
      if (index === -1) return null
      index += 2
      continue
    }
    if (character === '"' || character === "'") {
      const quote = character
      let value = ""
      let closed = false
      index += 1
      while (index < source.length) {
        const next = source[index]!
        if (next === "\\") return null
        if (next === quote) {
          closed = true
          index += 1
          break
        }
        if (next === "\n" || next === "\r") return null
        value += next
        index += 1
      }
      if (!closed) return null
      tokens.push({ kind: "string", value })
      continue
    }
    if (character === "`") return null
    const identifier = source.slice(index).match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0]
    if (identifier) {
      tokens.push({ kind: "identifier", value: identifier })
      index += identifier.length
      continue
    }
    const operator = ["...", "=>", "===", "!==", "==", "!=", "<=", ">="].find((candidate) =>
      source.startsWith(candidate, index)
    )
    if (operator) {
      tokens.push({ kind: "punctuation", value: operator })
      index += operator.length
      continue
    }
    tokens.push({ kind: "punctuation", value: character })
    index += 1
  }
  return tokens
}

function declaredObjectExpressions(tokens: JsToken[]): Map<string, number> {
  const declarations = new Map<string, number>()
  for (let index = 0; index < tokens.length - 3; index += 1) {
    if (!["const", "let", "var"].includes(tokens[index]!.value)) continue
    const name = tokens[index + 1]
    if (name?.kind !== "identifier") continue
    let depth = 0
    for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor]!.value
      if (["(", "[", "{"].includes(value)) depth += 1
      if ([")", "]", "}"].includes(value)) depth -= 1
      if (depth === 0 && value === ";") break
      if (depth === 0 && value === "=") {
        if (tokens[cursor + 1]?.value === "{") declarations.set(name.value, cursor + 1)
        break
      }
    }
  }
  return declarations
}

function literalRewritesFromConfig(tokens: JsToken[], objectStart: number): VercelRewrite[] | null {
  const objectEnd = matchingToken(tokens, objectStart, "{", "}")
  if (objectEnd === null) return null
  const properties = topLevelSegments(tokens, objectStart + 1, objectEnd)
  if (properties.some(([start]) => tokens[start]?.value === "...")) return null
  const rewrites = properties.filter(([start, end]) => {
    const key = tokens[start]?.value === "async" ? start + 1 : start
    return key < end && tokens[key]?.value === "rewrites"
  })
  if (rewrites.length !== 1) return null
  const [start, end] = rewrites[0]!
  const key = tokens[start]?.value === "async" ? start + 1 : start
  const arrayStart = returnedArrayStart(tokens, key, end)
  return arrayStart === null ? null : literalRewriteArray(tokens, arrayStart)
}

function returnedArrayStart(tokens: JsToken[], key: number, end: number): number | null {
  const next = tokens[key + 1]?.value
  if (next === "(") {
    const paramsEnd = matchingToken(tokens, key + 1, "(", ")")
    if (paramsEnd === null) return null
    const bodyStart = findToken(tokens, "{", paramsEnd + 1, end)
    return bodyStart === null ? null : returnedArrayInBody(tokens, bodyStart)
  }
  if (next !== ":") return null
  let cursor = key + 2
  if (tokens[cursor]?.value === "async") cursor += 1
  if (tokens[cursor]?.value === "(") {
    const paramsEnd = matchingToken(tokens, cursor, "(", ")")
    if (paramsEnd === null || tokens[paramsEnd + 1]?.value !== "=>") return null
    cursor = paramsEnd + 2
  } else {
    if (tokens[cursor]?.kind !== "identifier" || tokens[cursor + 1]?.value !== "=>") return null
    cursor += 2
  }
  if (tokens[cursor]?.value === "[") return cursor
  return tokens[cursor]?.value === "{" ? returnedArrayInBody(tokens, cursor) : null
}

function returnedArrayInBody(tokens: JsToken[], bodyStart: number): number | null {
  const bodyEnd = matchingToken(tokens, bodyStart, "{", "}")
  if (bodyEnd === null || tokens[bodyStart + 1]?.value !== "return") return null
  const arrayStart = bodyStart + 2
  if (tokens[arrayStart]?.value !== "[") return null
  const arrayEnd = matchingToken(tokens, arrayStart, "[", "]")
  if (arrayEnd === null) return null
  const remainder = tokens.slice(arrayEnd + 1, bodyEnd).filter((token) => token.value !== ";")
  return remainder.length === 0 ? arrayStart : null
}

function literalRewriteArray(tokens: JsToken[], arrayStart: number): VercelRewrite[] | null {
  const arrayEnd = matchingToken(tokens, arrayStart, "[", "]")
  if (arrayEnd === null) return null
  const rewrites: VercelRewrite[] = []
  for (const [start, end] of topLevelSegments(tokens, arrayStart + 1, arrayEnd)) {
    if (tokens[start]?.value !== "{") return null
    const objectEnd = matchingToken(tokens, start, "{", "}")
    if (objectEnd === null || objectEnd !== end - 1) return null
    const values = new Map<string, string>()
    for (const [propertyStart, propertyEnd] of topLevelSegments(tokens, start + 1, objectEnd)) {
      if (
        propertyEnd - propertyStart !== 3 ||
        tokens[propertyStart + 1]?.value !== ":" ||
        tokens[propertyStart + 2]?.kind !== "string"
      ) {
        return null
      }
      values.set(tokens[propertyStart]!.value, tokens[propertyStart + 2]!.value)
    }
    if (values.size !== 2 || !values.has("source") || !values.has("destination")) return null
    rewrites.push({ source: values.get("source")!, destination: values.get("destination")! })
  }
  return rewrites
}

function topLevelSegments(tokens: JsToken[], start: number, end: number): Array<[number, number]> {
  const segments: Array<[number, number]> = []
  let segmentStart = start
  let depth = 0
  for (let index = start; index < end; index += 1) {
    const value = tokens[index]!.value
    if (["(", "[", "{"].includes(value)) depth += 1
    if ([")", "]", "}"].includes(value)) depth -= 1
    if (depth === 0 && value === ",") {
      if (index > segmentStart) segments.push([segmentStart, index])
      segmentStart = index + 1
    }
  }
  if (end > segmentStart) segments.push([segmentStart, end])
  return segments
}

function matchingToken(
  tokens: JsToken[],
  start: number,
  open: string,
  close: string
): number | null {
  if (tokens[start]?.value !== open) return null
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) depth += 1
    if (tokens[index]?.value === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return null
}

function findToken(tokens: JsToken[], value: string, start: number, end: number): number | null {
  for (let index = start; index < end; index += 1) {
    if (tokens[index]?.value === value) return index
  }
  return null
}

/** Shared caveat surfaced by the vite-react + static-html adapters when they emit vercel.json. */
export const VERCEL_HOST_CAVEAT =
  "vercel.json rewrites only apply on Vercel. On other hosts, configure equivalent same-origin analytics routes before enabling collection."

function isManagedDestination(
  source: unknown,
  destination: unknown,
  pairs: VercelRewrite[]
): boolean {
  const expected = pairs.find((pair) => pair.source === source)
  if (!expected || typeof destination !== "string") return false
  return destination === expected.destination
}
