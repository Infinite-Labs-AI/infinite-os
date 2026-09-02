import { existsSync, readFileSync, statSync } from "node:fs"
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { spawnSync } from "node:child_process"

import { frameworkAdapters } from "./frameworks/index.js"
import { resolveConfinedAppRoot } from "./frameworks/shared.js"
import { isManagedInfiniteFile } from "./frameworks/managed-files.js"
import { readInstallManifest } from "./manifest.js"
import { detectPackageManager } from "./package-manager.js"
import type {
  InspectResult,
  PackageManager,
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
const providerScanSkippedFiles = /\.(d\.ts|test\.[jt]sx?|spec\.[jt]sx?|stories\.[jt]sx?|min\.[cm]?js)$/
/** Directories the walk never enters: dependencies, build output, VCS, coverage, static assets, tests, mocks, email templates. */
const providerScanSkippedDirectories = new Set([
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
 * GA4 through Google Tag Manager. Never the bare `GTM-XXXX` token (it matches any uppercase word
 * such as `GTM-CONTAINERLESS`) and never a bare `dataLayer.push(` (every e-commerce site pushes to
 * the data layer): evidence is the gtm.js loader, a data-layer push beside the googletagmanager
 * host, the `gtmId` prop of `@next/third-parties/google`, or a quoted id on a line mentioning gtm.
 */
function hasTagManagerEvidence(contents: string): boolean {
  if (contents.includes("googletagmanager.com/gtm.js")) return true
  if (contents.includes("dataLayer.push(") && contents.includes("googletagmanager.com")) return true
  if (gtmIdProp.test(contents)) return true
  return quotedGtmIdOnGtmLine.test(contents)
}

/**
 * GA4 installed directly: Google's own gtag loader / `gtag(` call, or one of the library wrappers
 * that install it without either string (`@next/third-parties/google` `<GoogleAnalytics>`,
 * `react-ga4`, `vue-gtag`, `nuxt-gtag`, `@analytics/google-analytics`).
 */
function hasGa4SnippetEvidence(contents: string): boolean {
  if (contents.includes("googletagmanager.com/gtag") || contents.includes("gtag(")) return true
  if (contents.includes("@next/third-parties/google") && contents.includes("GoogleAnalytics")) return true
  if (contents.includes("react-ga4") || contents.includes("ReactGA.initialize(")) return true
  if (contents.includes("vue-gtag") || contents.includes("nuxt-gtag")) return true
  return contents.includes("@analytics/google-analytics")
}

/**
 * PostHog: the initialisation call, the CDN host, or the React/Next wrappers that take the key as
 * a prop and default the host (`posthog-js/react` `<PostHogProvider>`, `@posthog/nextjs`).
 */
function hasPosthogEvidence(contents: string): boolean {
  if (contents.includes("posthog.init(") || contents.includes("i.posthog.com")) return true
  if (contents.includes("posthog-js/react") && contents.includes("PostHogProvider")) return true
  return contents.includes("@posthog/nextjs")
}

/**
 * Which providers one file's contents prove. Every signature is a real loader URL, call site,
 * or install-library import — bare product names in prose ("we evaluated posthog") never match.
 */
function providerSignatures(contents: string): ProviderSignature[] {
  const found: ProviderSignature[] = []
  if (hasGa4SnippetEvidence(contents)) {
    found.push({ provider: "ga4", via: "snippet" })
  } else if (hasTagManagerEvidence(contents)) {
    found.push({ provider: "ga4", via: "gtm" })
  }
  if (hasPosthogEvidence(contents)) {
    found.push({ provider: "posthog", via: "snippet" })
  }
  // X/Twitter pixel: its actual tag signatures only.
  if (contents.includes("twq(") || contents.includes("static.ads-twitter.com")) {
    found.push({ provider: "x", via: "snippet" })
  }
  // Infinite: the standalone loader src or its config globals — not bare prose.
  if (
    contents.includes("tracking/standalone.js") ||
    contents.includes("_1BU_CONFIG") ||
    contents.includes("data-1bu-workspace-id")
  ) {
    found.push({ provider: "infinite", via: "snippet" })
  }
  // Meta/Facebook pixel: its actual tag signatures only, not the word "facebook".
  if (contents.includes("fbevents.js") || contents.includes("fbq(") || contents.includes("connect.facebook.net")) {
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
    detectedFiles: bestMatch.result.files
  }
}
