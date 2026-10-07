import { existsSync, readFileSync, statSync } from "node:fs"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { spawnSync } from "node:child_process"

import { providerScanSkippedDirectories, providerScanSkippedFiles } from "./provider-scan-rules.js"
export { providerScanSkippedDirectories, providerScanSkippedFiles } from "./provider-scan-rules.js"

import { htmlScripts } from "./html-scripts.js"
import { providerInstallEvidence } from "./provider-evidence.js"

import { frameworkAdapters } from "./frameworks/index.js"
import { maskCommentsAndStrings, resolveConfinedAppRoot } from "./frameworks/shared.js"
import { isManagedInfiniteFile } from "./frameworks/managed-files.js"
import { readInstallManifest } from "./manifest.js"
import { detectPackageManager } from "./package-manager.js"
import type {
  InspectResult,
  PackageManager,
  PosthogConfigSummary,
  PosthogInitConfig,
  ProviderId,
  RepoStatus,
  UnmanagedProvider,
  UnmanagedProviderVia
} from "./types.js"

export interface InspectOptions {
  appRoot?: string
  packageManager?: PackageManager
}

export function detectRepoStatus(root: string): RepoStatus {
  const insideWorkTree = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf8"
  })
  if (insideWorkTree.status !== 0) {
    return "not-a-git-repo"
  }

  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], {
    encoding: "utf8"
  })

  if (status.status !== 0) {
    return "not-a-git-repo"
  }

  return status.stdout.trim().length > 0 ? "dirty" : "clean"
}

export { resolveConfinedAppRoot }

function discoverCandidateRoots(root: string, appRoot?: string): string[] {
  if (appRoot) {
    return [resolveConfinedAppRoot(root, appRoot)]
  }

  const candidates = [root]
  const appsDirectory = join(root, "apps")
  if (existsSync(appsDirectory)) {
    const entries = readdirSync(appsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    for (const entryName of entries) {
      candidates.push(join(appsDirectory, entryName))
    }
  }

  return candidates
}

/** Source files the provider walk reads. Anything else (markdown, JSON, images) is never opened. */
const providerScanExtensions = /\.(html|htm|tsx|jsx|ts|js|mjs|cjs|astro|vue|svelte)$/
/** Bounded so a huge monorepo cannot turn `inspect` into a minutes-long crawl. */
const providerScanMaxFiles = 2_000
const providerScanMaxFileBytes = 512 * 1024

/** Provider report order — stable regardless of which file matched first. */
const providerReportOrder: ProviderId[] = ["ga4", "posthog", "x", "meta", "infinite"]

interface ProviderSignature {
  provider: ProviderId
  via: UnmanagedProviderVia
}

/** A real GTM loader or official integration, not an event call or unused id. */
export function hasTagManagerEvidence(contents: string): boolean {
  return providerInstallEvidence(contents).some(entry => entry.via === "gtm")
}

/**
 * GA4 installed directly: Google's own gtag loader / `gtag(` call, or one of the library wrappers
 * that install it without either string (`@next/third-parties/google` `<GoogleAnalytics>`,
 * `react-ga4`, `vue-gtag`, `nuxt-gtag`, `@analytics/google-analytics`).
 */
export function hasGa4SnippetEvidence(contents: string): boolean {
  return providerInstallEvidence(contents).some(entry => entry.provider === "ga4" && entry.via === "snippet")
}

/**
 * PostHog: the initialisation call, the CDN host, or the React/Next wrappers that take the key as
 * a prop and default the host (`posthog-js/react` `<PostHogProvider>`, `@posthog/nextjs`).
 */
export function hasPosthogEvidence(contents: string): boolean {
  return providerInstallEvidence(contents).some(entry => entry.provider === "posthog")
}

/**
 * Which providers one file's contents prove. Every signature is a real loader URL, call site,
 * or install-library import — bare product names in prose ("we evaluated posthog") never match.
 */
function providerSignatures(contents: string): ProviderSignature[] {
  return providerInstallEvidence(contents).map(({provider, via}) => ({provider, via}))
}

function stripManagedHtmlBlocks(contents: string): string {
  return contents.replace(
    /<!-- infinite:start -->[\s\S]*?<!-- infinite:end -->/g,
    block => block.replace(/[^\n]/g, " ")
  )
}

/**
 * App-root-relative source files, sorted depth-first so results are deterministic, bounded by
 * count and size, never following symlinks (an app root is confined; a link could leave it).
 * Exported for the wizard's provider census (`checks/census.ts`), which walks exactly what inspect walks.
 */
export function walkProviderScanFiles(appRoot: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    if (files.length >= providerScanMaxFiles) return
    let entries
    try {
      entries = readdirSync(join(appRoot, directory), { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= providerScanMaxFiles) return
      const relativePath = directory === "" ? entry.name : `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (!providerScanSkippedDirectories.has(entry.name)) visit(relativePath)
        continue
      }
      if (!entry.isFile() || !providerScanExtensions.test(entry.name)) continue
      if (providerScanSkippedFiles.test(entry.name)) continue
      try {
        if (statSync(join(appRoot, relativePath)).size > providerScanMaxFileBytes) continue
      } catch {
        continue
      }
      files.push(relativePath)
    }
  }
  visit("")
  return files
}

function scanProviders(appRoot: string, options: { skipManaged: boolean }): UnmanagedProvider[] {
  const byProvider = new Map<ProviderId, UnmanagedProvider>()
  for (const file of walkProviderScanFiles(appRoot)) {
    let contents: string
    try {
      contents = readFileSync(join(appRoot, file), "utf8")
    } catch {
      continue
    }
    if (options.skipManaged) {
      if (isManagedInfiniteFile(contents)) continue
      contents = stripManagedHtmlBlocks(contents)
    }
    for (const signature of providerSignatures(contents)) {
      const current = byProvider.get(signature.provider)
      // First file wins, except that a real snippet outranks a Tag Manager hint found earlier.
      if (!current || (current.via === "gtm" && signature.via === "snippet")) {
        byProvider.set(signature.provider, { ...signature, file })
      }
    }
  }
  return providerReportOrder
    .map((provider) => byProvider.get(provider))
    .filter((entry): entry is UnmanagedProvider => entry !== undefined)
}

/**
 * Provider installs that exist in the app and are NOT managed by Infinite (managed files and
 * `<!-- infinite:start -->` blocks are ignored). Scans the whole app root, not a fixed file list.
 */
export function detectUnmanagedProviders(appRoot: string): UnmanagedProvider[] {
  return scanProviders(appRoot, { skipManaged: true })
}

/**
 * Statically reads one option value out of a PostHog init config (`posthog.init(key, { … })` or a
 * `<PostHogProvider options={{ … }}>`). Returns the value exactly as written (quotes stripped),
 * or undefined when the key is absent or its value can't be read statically (an expression, a
 * spread, a variable). Never guesses — undefined surfaces as "not detected" to the founder.
 */
export function readPosthogOption(contents: string, key: string): string | undefined {
  // key: <value>  — value runs to the next comma, newline, or closing brace.
  const match = new RegExp(`(?:^|[\\s,{(])${key}\\s*:\\s*([^,\\n}]+)`, "m").exec(contents)
  if (!match) return undefined
  let raw = match[1].trim()
  if (raw.length === 0) return undefined
  // A quoted string literal: take exactly the quoted content. URLs contain "//", so this must run
  // before any inline-comment stripping or the host value would be truncated at the scheme.
  const quoted = /^(['"`])(.*?)\1/.exec(raw)
  if (quoted) return quoted[2].length > 0 ? quoted[2] : undefined
  // Unquoted (boolean / number / object / expression): drop a trailing line comment.
  raw = raw.replace(/\/\/.*$/, "").trim()
  if (raw.length === 0) return undefined
  // A nested object (e.g. `autocapture: { … }`) or an expression is not a plain literal.
  if (raw.startsWith("{")) return "custom (object)"
  return raw
}

/**
 * One PostHog option as written, telling a LITERAL apart from a value the wizard cannot read (live-fix 4 final
 * round, P1): `api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST` is PostHog's documented setup, and it says
 * nothing about where the events go. `literal` = the whole value is one plain string (quotes stripped, a template
 * with no `${…}`), a boolean, a number, null or undefined; `expression` = anything else (an identifier, an env
 * read, a call, a ternary, a concatenation, a shorthand `{ api_host }`, an object). Undefined = the key is absent.
 */
export type PosthogOptionValue = { kind: "literal"; value: string } | { kind: "expression"; text: string }

export function readPosthogOptionValue(contents: string, key: string): PosthogOptionValue | undefined {
  const match = new RegExp(`(?:^|[\\s,{(])${key}\\s*:\\s*([^,\\n}]+)`, "m").exec(contents)
  if (!match) {
    // `{ api_host }` / `{ …, api_host, … }`: the value is a variable of the same name.
    const shorthand = new RegExp(`[{,]\\s*${key}\\s*(?=[,}])`).exec(contents)
    return shorthand ? { kind: "expression", text: key } : undefined
  }
  const raw = match[1]!.trim()
  const quoted = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1\s*(?:\/\/.*)?$/.exec(raw)
  if (quoted) {
    if (quoted[1] === "`" && quoted[2]!.includes("${")) return { kind: "expression", text: raw }
    return { kind: "literal", value: quoted[2]! }
  }
  const bare = raw.replace(/\/\/.*$/, "").trim()
  if (/^(?:true|false|null|undefined|-?\d+(?:\.\d+)?)$/.test(bare)) return { kind: "literal", value: bare }
  return { kind: "expression", text: bare === "" ? raw : bare }
}

/** The PostHog options read from one init (`posthog.init(…)` or `<PostHogProvider options={…}>`). */
function readPosthogInitOptions(contents: string): Omit<PosthogInitConfig, "file" | "line"> {
  return {
    autocapture: readPosthogOption(contents, "autocapture"),
    disableSessionRecording: readPosthogOption(contents, "disable_session_recording"),
    capturePageview: readPosthogOption(contents, "capture_pageview"),
    capturePageleave: readPosthogOption(contents, "capture_pageleave"),
    persistence: readPosthogOption(contents, "persistence"),
    apiHost: readPosthogOption(contents, "api_host"),
    uiHost: readPosthogOption(contents, "ui_host"),
    defaults: readPosthogOption(contents, "defaults")
  }
}

/** The text of one init call: from the call to its matching close paren (bounded), so two inits never mix. */
function initCallText(contents: string, start: number): string {
  const open = contents.indexOf("(", start)
  const jsx = contents.startsWith("<PostHogProvider", start)
  if (jsx) {
    const close = contents.indexOf(">", start)
    return contents.slice(start, close === -1 ? start + 2000 : close + 1)
  }
  if (open === -1) return contents.slice(start, start + 2000)
  let depth = 0
  for (let i = open; i < contents.length && i < start + 8000; i += 1) {
    const ch = contents[i]
    if (ch === "(") depth += 1
    else if (ch === ")") {
      depth -= 1
      if (depth === 0) return contents.slice(start, i + 1)
    }
  }
  return contents.slice(start, start + 2000)
}

/**
 * The cost/privacy-relevant PostHog options a founder needs to audit — session replay and
 * autocapture drive billing. Reads EVERY init in EVERY scanned file that carries PostHog evidence
 * (lane O6: a site with an init in the layout and another in a page has two configs, and the wizard's
 * duplicate and D17 lines need both), each with its file:line, and skips Infinite's managed files and
 * managed HTML blocks (those are infinite-tag's own bytes, not the founder's config). The summary's
 * top-level fields are the FIRST init's, as before; `inits` lists them all. Read-only; returns
 * undefined when no PostHog install is found.
 */
export function detectPosthogConfig(appRoot: string): PosthogConfigSummary | undefined {
  const inits: PosthogInitConfig[] = []
  for (const file of walkProviderScanFiles(appRoot)) {
    let contents: string
    try {
      contents = readFileSync(join(appRoot, file), "utf8")
    } catch {
      continue
    }
    if (isManagedInfiniteFile(contents)) continue
    contents = stripManagedHtmlBlocks(contents)
    if (!hasPosthogEvidence(contents)) continue
    // HTML: only script bodies are code (an apostrophe in page text must not mask what follows).
    const regions: Array<[number, number]> = /\.html?$/i.test(file)
      ? htmlScripts(contents, true).map((script) => [script.bodyStart, script.bodyEnd])
      : [[0, contents.length]]
    const starts: number[] = []
    for (const [from, to] of regions) {
      const code = maskCommentsAndStrings(contents.slice(from, to), true)
      for (const match of code.matchAll(/\bposthog\s*\.\s*init\s*\(|<PostHogProvider\b/g)) starts.push(from + match.index)
    }
    if (starts.length === 0) {
      // Evidence without a readable init (a CDN loader, a wrapper): the file's options, as before.
      inits.push({ file, line: 1, ...readPosthogInitOptions(contents) })
      continue
    }
    for (const start of starts) {
      const line = contents.slice(0, start).split("\n").length
      inits.push({ file, line, ...readPosthogInitOptions(initCallText(contents, start)) })
    }
  }
  const first = inits[0]
  if (!first) return undefined
  return { ...first, inits }
}

function detectExistingProviders(root: string, appRoot: string): string[] {
  const manifest = readInstallManifest(root)
  if (manifest) {
    return manifest.providers
  }

  return scanProviders(appRoot, { skipManaged: false }).map((entry) => entry.provider)
}

export function inspectWorkspace(root: string, options: InspectOptions = {}): InspectResult {
  const packageManagerDetection = detectPackageManager(root, options.packageManager)
  const packageManager = packageManagerDetection.kind
  const repoStatus = detectRepoStatus(root)
  const candidates = discoverCandidateRoots(root, options.appRoot)

  let bestMatch:
    | {
        root: string
        result: ReturnType<(typeof frameworkAdapters)[number]["detect"]>
      }
    | undefined

  for (const candidate of candidates) {
    for (const adapter of frameworkAdapters) {
      const result = adapter.detect(candidate)
      if (!result) {
        continue
      }

      if (!bestMatch || result.confidence > bestMatch.result!.confidence) {
        bestMatch = { root: candidate, result }
      }
    }
  }

  if (!bestMatch || !bestMatch.result) {
    return {
      framework: "unsupported",
      appRoot: ".",
      packageManager,
      confidence: 0.2,
      existingProviders: [],
      repoStatus,
      assumptions:
        packageManagerDetection.kind === "ambiguous"
          ? ["Multiple lockfiles were detected. Founder choice is required before printing install commands."]
          : [],
      blockers: ["Unsupported repository shape for instrumentation."],
      detectedFiles: packageManagerDetection.lockfiles
    }
  }

  const relativeAppRoot = relative(root, bestMatch.root) || "."
  const existingProviders = detectExistingProviders(root, bestMatch.root)
  // Surface the cost/privacy-relevant PostHog options whenever a PostHog install is present, so a
  // founder can audit session replay + autocapture (both drive billing) from `inspect` alone.
  const posthogConfig = existingProviders.includes("posthog")
    ? detectPosthogConfig(bestMatch.root)
    : undefined
  const assumptions = [...bestMatch.result.assumptions]
  if (packageManagerDetection.kind === "ambiguous") {
    assumptions.push("Multiple lockfiles were detected. Founder choice is required before printing install commands.")
  }

  return {
    framework: bestMatch.result.framework,
    appRoot: relativeAppRoot,
    packageManager,
    confidence: bestMatch.result.confidence,
    existingProviders,
    repoStatus,
    assumptions,
    blockers: [],
    detectedFiles: bestMatch.result.files,
    ...(posthogConfig ? { posthogConfig } : {})
  }
}
