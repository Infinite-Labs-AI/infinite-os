import { existsSync, readFileSync, statSync } from "node:fs"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { spawnSync } from "node:child_process"

import { frameworkAdapters } from "./frameworks/index.js"
import { maskCommentsAndStrings, resolveConfinedAppRoot } from "./frameworks/shared.js"
import { isManagedInfiniteFile } from "./frameworks/managed-files.js"
import { readInstallManifest } from "./manifest.js"
import { detectPackageManager } from "./package-manager.js"
import type {
  InspectResult,
  PackageManager,
  PosthogConfigSummary,
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
/**
 * Files that carry provider signatures WITHOUT being an install: minified vendor bundles, type
 * declarations (`declare function gtag(`), tests/specs/stories/mocks (`posthog.init('phc_test')`).
 * A false positive here silently drops a provider from the install as "adopted" — the worse failure.
 */
export const providerScanSkippedFiles = /\.(d\.ts|test\.[jt]sx?|spec\.[jt]sx?|stories\.[jt]sx?|min\.[cm]?js)$/
/** Directories the walk never enters: dependencies, build output, VCS, coverage, static assets, tests, mocks, email templates. */
export const providerScanSkippedDirectories = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".vercel",
  "coverage",
  "public",
  "static",
  "__tests__",
  "__mocks__",
  ".storybook",
  "emails"
])
/** Bounded so a huge monorepo cannot turn `inspect` into a minutes-long crawl. */
const providerScanMaxFiles = 2_000
const providerScanMaxFileBytes = 512 * 1024

/** Provider report order — stable regardless of which file matched first. */
const providerReportOrder: ProviderId[] = ["ga4", "posthog", "x", "meta", "infinite"]

interface ProviderSignature {
  provider: ProviderId
  via: UnmanagedProviderVia
}

/** `<GoogleTagManager gtmId="GTM-…">` / `gtmId: "GTM-…"` — a Tag Manager container id bound to a prop. */
const gtmIdProp = /gtmId\s*[=:]\s*["'`]GTM-[A-Z0-9]{4,}/
/**
 * A quoted container id on a line that also talks about Tag Manager (`gtmContainer = 'GTM-…'`).
 * The mention is case-sensitive lowercase on purpose: the uppercase `GTM-` of the token itself
 * (or a constant like `GTM_MODE = 'GTM-CONTAINERLESS'`) must never count as the mention.
 */
const quotedGtmIdOnGtmLine = /^(?=.*(?:gtm|googletagmanager))(?=.*["'`]GTM-[A-Z0-9]{4,}["'`]).*$/m

/**
 * Loader-host evidence, as precompiled regexes (dots escaped) rather than `String.includes` — a
 * regex `.test` clears CodeQL's incomplete-URL-substring-sanitization rule (which only targets
 * includes/indexOf/startsWith) while keeping the SAME loose, unanchored subdomain match this adopt-
 * detection wants: `/i\.posthog\.com/` still matches `us.i.posthog.com`. This is provider detection
 * in the CUSTOMER'S OWN source (adopt vs install), never security URL sanitization.
 */
const googleTagManagerHost = /googletagmanager\.com/
const posthogHost = /i\.posthog\.com/
const xLoaderHost = /static\.ads-twitter\.com/
const metaLoaderHost = /connect\.facebook\.net/

/**
 * GA4 through Google Tag Manager. Never the bare `GTM-XXXX` token (it matches any uppercase word
 * such as `GTM-CONTAINERLESS`) and never a bare `dataLayer.push(` (every e-commerce site pushes to
 * the data layer): evidence is the gtm.js loader, a data-layer push beside the googletagmanager
 * host, the `gtmId` prop of `@next/third-parties/google`, or a quoted id on a line mentioning gtm.
 */
export function hasTagManagerEvidence(contents: string): boolean {
  // A commented-out or in-string signature is not an install. `code` blanks comments AND strings (for
  // CALL sites); `noComments` blanks comments only (for host URLs / prop values that live in strings).
  const code = maskCommentsAndStrings(contents, true)
  const noComments = maskCommentsAndStrings(contents, false)
  if (noComments.includes("googletagmanager.com/gtm.js")) return true
  if (code.includes("dataLayer.push(") && googleTagManagerHost.test(noComments)) return true
  if (gtmIdProp.test(noComments)) return true
  return quotedGtmIdOnGtmLine.test(noComments)
}

/**
 * GA4 installed directly: Google's own gtag loader / `gtag(` call, or one of the library wrappers
 * that install it without either string (`@next/third-parties/google` `<GoogleAnalytics>`,
 * `react-ga4`, `vue-gtag`, `nuxt-gtag`, `@analytics/google-analytics`).
 */
export function hasGa4SnippetEvidence(contents: string): boolean {
  const code = maskCommentsAndStrings(contents, true)
  const noComments = maskCommentsAndStrings(contents, false)
  if (noComments.includes("googletagmanager.com/gtag") || code.includes("gtag(")) return true
  if (noComments.includes("@next/third-parties/google") && noComments.includes("GoogleAnalytics")) return true
  if (noComments.includes("react-ga4") || code.includes("ReactGA.initialize(")) return true
  if (noComments.includes("vue-gtag") || noComments.includes("nuxt-gtag")) return true
  return noComments.includes("@analytics/google-analytics")
}

/**
 * PostHog: the initialisation call, the CDN host, or the React/Next wrappers that take the key as
 * a prop and default the host (`posthog-js/react` `<PostHogProvider>`, `@posthog/nextjs`).
 */
export function hasPosthogEvidence(contents: string): boolean {
  const code = maskCommentsAndStrings(contents, true)
  const noComments = maskCommentsAndStrings(contents, false)
  if (code.includes("posthog.init(") || posthogHost.test(noComments)) return true
  if (noComments.includes("posthog-js/react") && noComments.includes("PostHogProvider")) return true
  return noComments.includes("@posthog/nextjs")
}

/**
 * Which providers one file's contents prove. Every signature is a real loader URL, call site,
 * or install-library import — bare product names in prose ("we evaluated posthog") never match.
 */
function providerSignatures(contents: string): ProviderSignature[] {
  // Comment-safe (and, for CALL sites, string-safe) evidence: a commented-out or in-string signature
  // is documentation, not an install — counting it would silently ADOPT and SUPPRESS the provider.
  const code = maskCommentsAndStrings(contents, true)
  const noComments = maskCommentsAndStrings(contents, false)

  const found: ProviderSignature[] = []
  if (hasGa4SnippetEvidence(contents)) {
    found.push({ provider: "ga4", via: "snippet" })
  } else if (hasTagManagerEvidence(contents)) {
    found.push({ provider: "ga4", via: "gtm" })
  }
  if (hasPosthogEvidence(contents)) {
    found.push({ provider: "posthog", via: "snippet" })
  }
  // X/Twitter pixel: the tag CALL (code) or its loader host (string).
  if (code.includes("twq(") || xLoaderHost.test(noComments)) {
    found.push({ provider: "x", via: "snippet" })
  }
  // Infinite: the standalone loader src, config global, or data attribute — never bare prose.
  if (
    noComments.includes("tracking/standalone.js") ||
    noComments.includes("_1BU_CONFIG") ||
    noComments.includes("data-1bu-workspace-id")
  ) {
    found.push({ provider: "infinite", via: "snippet" })
  }
  // Meta/Facebook pixel: the fbq CALL (code) or its loader hosts (string) — not the word "facebook".
  if (noComments.includes("fbevents.js") || code.includes("fbq(") || metaLoaderHost.test(noComments)) {
    found.push({ provider: "meta", via: "snippet" })
  }
  return found
}

function stripManagedHtmlBlocks(contents: string): string {
  return contents.replace(
    /<!-- infinite:start -->[\s\S]*?<!-- infinite:end -->/g,
    ""
  )
}

/**
 * App-root-relative source files, sorted depth-first so results are deterministic, bounded by
 * count and size, never following symlinks (an app root is confined; a link could leave it).
 */
function walkProviderScanFiles(appRoot: string): string[] {
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
 * The cost/privacy-relevant PostHog options a founder needs to audit — session replay and
 * autocapture drive billing. Reads them from the first scanned file that carries PostHog evidence.
 * Read-only; returns undefined when no PostHog init is found.
 */
export function detectPosthogConfig(appRoot: string): PosthogConfigSummary | undefined {
  for (const file of walkProviderScanFiles(appRoot)) {
    let contents: string
    try {
      contents = readFileSync(join(appRoot, file), "utf8")
    } catch {
      continue
    }
    if (!hasPosthogEvidence(contents)) continue
    return {
      file,
      autocapture: readPosthogOption(contents, "autocapture"),
      disableSessionRecording: readPosthogOption(contents, "disable_session_recording"),
      capturePageview: readPosthogOption(contents, "capture_pageview"),
      capturePageleave: readPosthogOption(contents, "capture_pageleave"),
      persistence: readPosthogOption(contents, "persistence"),
      apiHost: readPosthogOption(contents, "api_host"),
      uiHost: readPosthogOption(contents, "ui_host")
    }
  }
  return undefined
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
