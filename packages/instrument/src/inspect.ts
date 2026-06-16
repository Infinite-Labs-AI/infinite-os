import { existsSync, readFileSync } from "node:fs"
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
  RepoStatus
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

const providerScanCandidates = [
  "index.html",
  "src/main.tsx",
  "src/main.jsx",
  "src/lib/infinite-analytics.ts",
  "app/layout.tsx",
  "pages/_app.tsx",
  "lib/infinite-analytics.ts"
]

function scanContentsForProviders(contents: string, detected: Set<string>): void {
  // GA4: match the actual tag loader URL or the gtag() function call signature.
  // Bare "google" or "gtag" strings in prose will not trigger this.
  if (contents.includes("googletagmanager.com/gtag") || contents.includes("gtag(")) {
    detected.add("ga4")
  }
  // PostHog: match the initialisation call or the CDN host, not the bare product name.
  // Ordinary copy mentioning "posthog" (e.g. in a README or marketing page) will not trigger.
  if (contents.includes("posthog.init(") || contents.includes("i.posthog.com")) {
    detected.add("posthog")
  }
  // X/Twitter pixel: match its actual tag signatures only.
  if (contents.includes("twq(") || contents.includes("static.ads-twitter.com")) {
    detected.add("x")
  }
}

function stripManagedHtmlBlocks(contents: string): string {
  return contents.replace(
    /<!-- infinite:start -->[\s\S]*?<!-- infinite:end -->/g,
    ""
  )
}

export function detectUnmanagedProviders(appRoot: string): string[] {
  const detected = new Set<string>()
  for (const candidate of providerScanCandidates) {
    const absolutePath = join(appRoot, candidate)
    if (!existsSync(absolutePath)) {
      continue
    }

    const contents = readFileSync(absolutePath, "utf8")
    if (isManagedInfiniteFile(contents)) {
      continue
    }

    scanContentsForProviders(stripManagedHtmlBlocks(contents), detected)
  }

  return [...detected]
}

function detectExistingProviders(root: string, appRoot: string): string[] {
  const manifest = readInstallManifest(root)
  if (manifest) {
    return manifest.providers
  }

  const detected = new Set<string>()
  for (const candidate of providerScanCandidates) {
    const absolutePath = join(appRoot, candidate)
    if (!existsSync(absolutePath)) {
      continue
    }

    scanContentsForProviders(readFileSync(absolutePath, "utf8"), detected)
  }

  return [...detected]
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
