import { readdirSync, type Dirent } from "node:fs"
import { join } from "node:path"

import type { FrameworkAdapter, InstallInstruction } from "../types.js"
import { infiniteProxySpec } from "../workspace-artifacts.js"

import {
  fileExists,
  indentBlock,
  normalizeAppRelativePath,
  readRequiredFile,
  readWorkspacePackageJson,
  writeFileIfChanged
} from "./shared.js"
import {
  buildVercelJson,
  applyManagedVercelJson,
  reverseManagedVercelJson,
  VERCEL_CONFIG_FILE,
  VERCEL_HOST_CAVEAT
} from "./vercel-config.js"

const managedStartMarker = "<!-- infinite:start -->"
const managedEndMarker = "<!-- infinite:end -->"

export const staticHtmlAdapter: FrameworkAdapter = {
  id: "static-html",
  displayName: "Static HTML",
  detect(root) {
    // index.html is the anchor that classifies a repo as a plain static site.
    // Without it we don't claim the repo (a random nested *.html shouldn't win).
    if (!fileExists(root, "index.html")) {
      return null
    }

    const files = findHtmlPages(root)
    const pkg = readWorkspacePackageJson(root)
    if (pkg && packageJsonHasFrameworkDeps(pkg)) {
      // A real framework dependency is present — this is ambiguous, stay cautious.
      return {
        framework: "static-html",
        confidence: 0.6,
        files,
        assumptions: [
          "index.html sits next to a package.json, so this may be a framework app rather than a plain static site. Confirm before applying."
        ]
      }
    }

    return {
      framework: "static-html",
      confidence: 0.78,
      files,
      assumptions:
        files.length > 1
          ? [
              `Static HTML wiring will target ${files.length} HTML pages under this directory (index.html + ${files.length - 1} more).`
            ]
          : ["Static HTML wiring will target index.html directly."]
    }
  },
  plan(root, options) {
    const detected = this.detect(root)
    const pages = detected?.files ?? []

    const blockers: string[] = []
    if (!fileExists(root, "index.html")) {
      blockers.push("Static HTML apply requires an index.html file.")
    } else {
      // Every page we intend to instrument must have a </head> to inject into.
      // A single missing tag anywhere blocks the whole plan so no page is silently skipped.
      for (const page of pages) {
        if (!readRequiredFile(root, page).includes("</head>")) {
          blockers.push(missingHeadMessage(page))
        }
      }
    }

    const proxy = {
      posthog: options?.posthogProxy,
      infinite: options?.infiniteProxy
    }
    const hasManagedProxy = Boolean(proxy.posthog || proxy.infinite)
    if (
      proxy.infinite &&
      !options?.allowStaticVercelProxy &&
      !fileExists(root, VERCEL_CONFIG_FILE)
    ) {
      blockers.push(
        "Infinite requires a proven same-origin proxy. Add vercel.json or pass --infinite-static-proxy vercel."
      )
    }
    const pageAssumptions =
      pages.length > 1
        ? [
            `Static HTML wiring injects the managed analytics block into every discovered page: ${pages.join(", ")}.`
          ]
        : [
            "Static HTML wiring uses direct public snippets rather than framework-specific runtime hooks."
          ]

    // The HTML pages, then (once) vercel.json — never inside the per-page fan-out. isHtmlPath
    // keeps vercel.json out of the page loops in apply()/uninstall().
    const files = pages.length > 0 ? [...pages] : ["index.html"]
    const instructions: InstallInstruction[] = []
    if (hasManagedProxy) {
      const vercelExists = fileExists(root, VERCEL_CONFIG_FILE)
      files.push(VERCEL_CONFIG_FILE)
      instructions.push({
        path: VERCEL_CONFIG_FILE,
        action: vercelExists ? "modify" : "create",
        description: vercelExists
          ? "Merge the managed analytics rewrites into your existing vercel.json."
          : "Create vercel.json with the managed analytics rewrites.",
        snippet: buildVercelJson(proxy)
      })
    }

    return {
      files,
      applyMode: blockers.length === 0 ? "supported" : "plan-only",
      instructions,
      assumptions: pageAssumptions,
      blockers,
      confidence: detected?.confidence ?? 0.75
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const pages = htmlPagesFromRootRelative(context.plan.files, context.appRoot)
    if (pages.length === 0) {
      // A static-html plan always lists at least index.html; this is a guardrail.
      throw new Error("Static HTML apply requires at least one HTML page to instrument.")
    }

    // Provider snippets are page-agnostic — every page receives the same managed block.
    const providerSnippets = context.plan.instructions
      .filter((instruction) => instruction.provider && isHtmlPath(instruction.path))
      .map((instruction) => instruction.snippet.trim())
      .filter((snippet) => snippet.length > 0)

    const managedBlock = [
      managedStartMarker,
      ...providerSnippets.flatMap((snippet) => ["", indentBlock(snippet, 2)]),
      "",
      managedEndMarker
    ].join("\n")

    const managedPattern = new RegExp(
      `${escapeForRegExp(managedStartMarker)}[\\s\\S]*?${escapeForRegExp(managedEndMarker)}`,
      "m"
    )

    const changedFiles: string[] = []
    const configOwnership = {}
    for (const page of pages) {
      const html = readRequiredFile(appRoot, page)
      if (!html.includes("</head>")) {
        throw new Error(missingHeadMessage(page))
      }

      // Function replacers so any `$` sequence inside the managed block is inserted
      // verbatim — never interpreted as a replacement pattern (`$&`, `$1`, …).
      const nextHtml = html.includes(managedStartMarker)
        ? html.replace(managedPattern, () => managedBlock)
        : html.replace("</head>", () => `${managedBlock}\n</head>`)

      if (writeFileIfChanged(appRoot, page, nextHtml)) {
        changedFiles.push(normalizeAppRelativePath(context.appRoot, page))
      }
    }

    // vercel.json is written exactly ONCE, outside the per-page loop.
    const warnings: string[] = []
    const proxy = {
      posthog: context.plan.artifacts.posthog?.proxy,
      infinite: infiniteProxySpec(context.plan.artifacts.infinite)
    }
    if (proxy.posthog || proxy.infinite) {
      const rootRelativeConfig = normalizeAppRelativePath(context.appRoot, VERCEL_CONFIG_FILE)
      const appliedConfig = applyManagedVercelJson({
        appRootAbsolute: appRoot,
        proxy,
        previousOwnership: context.previousManifest?.configOwnership?.[rootRelativeConfig]
      })
      if (appliedConfig.changed) {
        changedFiles.push(rootRelativeConfig)
      }
      if (appliedConfig.ownership) {
        Object.assign(configOwnership, {
          [rootRelativeConfig]: appliedConfig.ownership
        })
      }
      warnings.push(VERCEL_HOST_CAVEAT)
    }

    return {
      changedFiles,
      warnings,
      configOwnership
    }
  },
  uninstall(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const pages = htmlPagesFromRootRelative(context.manifest.files, context.appRoot)
    const restoredFiles: string[] = []
    const warnings: string[] = []

    const managedPattern = new RegExp(
      `${escapeForRegExp(managedStartMarker)}[\\s\\S]*?${escapeForRegExp(managedEndMarker)}\\n?`,
      "m"
    )

    for (const page of pages) {
      if (!fileExists(appRoot, page)) {
        warnings.push(`Managed file already absent: ${page}`)
        continue
      }

      const html = readRequiredFile(appRoot, page)
      const nextHtml = html.replace(managedPattern, "")
      if (nextHtml === html) {
        warnings.push(`No managed Infinite block found in ${page}.`)
      } else {
        if (!context.dryRun) {
          writeFileIfChanged(appRoot, page, nextHtml)
        }
        restoredFiles.push(normalizeAppRelativePath(context.appRoot, page))
      }
    }

    // Reverse the once-written vercel.json (outside the per-page loop).
    const vercelReversal = reverseManagedVercelJson({
      manifestFiles: context.manifest.files,
      ownership:
        context.manifest.configOwnership?.[
          normalizeAppRelativePath(context.appRoot, VERCEL_CONFIG_FILE)
        ],
      appRootAbsolute: appRoot,
      appRootRelative: context.appRoot,
      dryRun: context.dryRun
    })

    return {
      removedFiles: vercelReversal.removedFiles,
      restoredFiles: [...restoredFiles, ...vercelReversal.restoredFiles],
      warnings: [...warnings, ...vercelReversal.warnings]
    }
  }
}

/** Legacy string for index.html is preserved for compatibility; other pages name themselves. */
function missingHeadMessage(page: string): string {
  return page === "index.html"
    ? "Static HTML apply requires a closing </head> tag."
    : `Static HTML apply requires a closing </head> tag in ${page}.`
}

function isHtmlPath(path: string): boolean {
  return path.endsWith(".html") || path.endsWith(".htm")
}

/** Map root-relative manifest/plan file entries back to app-relative HTML page paths. */
function htmlPagesFromRootRelative(files: string[], appRoot: string): string[] {
  return files.filter(isHtmlPath).map((file) => toAppRelativePage(appRoot, file))
}

function toAppRelativePage(appRoot: string, rootRelativePath: string): string {
  if (appRoot === "." || appRoot.length === 0) {
    return rootRelativePath
  }
  const prefix = `${appRoot}/`
  return rootRelativePath.startsWith(prefix)
    ? rootRelativePath.slice(prefix.length)
    : rootRelativePath
}

// Directories that hold generated output or third-party code — never instrument
// HTML found inside them. Dot-directories (.git, .infinite, .next, .vercel,
// .svelte-kit, …) are skipped separately by the leading-dot check below.
const ignoredDirNames = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "vendor",
  "tmp",
  "temp"
])

/**
 * Recursively collect every HTML page under the app root, as app-relative,
 * forward-slash paths. This is what makes a MULTI-PAGE static site (e.g.
 * index.html + privacy/index.html + terms/index.html) fully instrumented rather
 * than instrumenting only the top-level index.html and silently missing the rest.
 *
 * Because infinite-tag runs on a SOURCE tree (not a curated build output), we
 * exclude dot-directories and common build/vendor dirs so generated or
 * third-party HTML is never touched. Symlinked dirs/files are skipped
 * (Dirent.isDirectory / isFile are false for symlinks), which also keeps
 * discovery inside the workspace root. index.html is hoisted to the front; the
 * remaining pages are sorted for deterministic plans, manifests, and output.
 */
function findHtmlPages(appRoot: string): string[] {
  const pages: string[] = []

  const walk = (absoluteDir: string, relativeDir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (ignoredDirNames.has(entry.name)) {
          continue
        }
        walk(join(absoluteDir, entry.name), relativePath)
      } else if (entry.isFile() && isHtmlPath(entry.name)) {
        pages.push(relativePath)
      }
    }
  }

  walk(appRoot, "")

  pages.sort()
  const indexPosition = pages.indexOf("index.html")
  if (indexPosition > 0) {
    pages.splice(indexPosition, 1)
    pages.unshift("index.html")
  }
  return pages
}

function escapeForRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Framework-like dependency names that indicate the site is NOT a plain static
// HTML project, making the static-html adapter a risky choice.
const frameworkDepNames = new Set([
  "react",
  "react-dom",
  "vue",
  "svelte",
  "@sveltejs/kit",
  "next",
  "nuxt",
  "vite",
  "@angular/core",
  "gatsby",
  "remix",
  "@remix-run/react",
  "astro",
  "solid-js"
])

interface PackageJsonShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function packageJsonHasFrameworkDeps(pkg: PackageJsonShape): boolean {
  const allDeps = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {})
  ]
  return allDeps.some((dep) => frameworkDepNames.has(dep))
}
