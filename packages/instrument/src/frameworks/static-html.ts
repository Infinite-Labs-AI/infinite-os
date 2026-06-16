import { join } from "node:path"

import type { FrameworkAdapter } from "../types.js"

import {
  fileExists,
  indentBlock,
  normalizeAppRelativePath,
  readRequiredFile,
  readWorkspacePackageJson,
  writeFileIfChanged
} from "./shared.js"

const managedStartMarker = "<!-- infinite:start -->"
const managedEndMarker = "<!-- infinite:end -->"

export const staticHtmlAdapter: FrameworkAdapter = {
  id: "static-html",
  displayName: "Static HTML",
  detect(root) {
    if (!fileExists(root, "index.html")) {
      return null
    }

    const pkg = readWorkspacePackageJson(root)
    if (pkg) {
      if (packageJsonHasFrameworkDeps(pkg)) {
        // A real framework dependency is present — this is ambiguous, stay cautious.
        return {
          framework: "static-html",
          confidence: 0.6,
          files: ["index.html"],
          assumptions: [
            "index.html sits next to a package.json, so this may be a framework app rather than a plain static site. Confirm before applying."
          ]
        }
      }
      // package.json exists but only has build/lint/test tooling — treat as confidently static.
    }

    return {
      framework: "static-html",
      confidence: 0.78,
      files: ["index.html"],
      assumptions: ["Static HTML wiring will target index.html directly."]
    }
  },
  plan(root) {
    const detected = this.detect(root)

    const blockers: string[] = []
    if (!fileExists(root, "index.html")) {
      blockers.push("Static HTML apply requires an index.html file.")
    } else if (!readRequiredFile(root, "index.html").includes("</head>")) {
      blockers.push("Static HTML apply requires a closing </head> tag.")
    }

    return {
      files: ["index.html"],
      applyMode: blockers.length === 0 ? "supported" : "plan-only",
      instructions: [],
      assumptions: [
        "Static HTML wiring uses direct public snippets rather than framework-specific runtime hooks."
      ],
      blockers,
      confidence: detected?.confidence ?? 0.75
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const htmlPath = "index.html"
    const rootRelativeHtmlPath = normalizeAppRelativePath(context.appRoot, htmlPath)
    const html = readRequiredFile(appRoot, htmlPath)
    if (!html.includes("</head>")) {
      throw new Error("Static HTML apply requires a closing </head> tag.")
    }

    const providerSnippets = context.plan.instructions
      .filter((instruction) => instruction.path === rootRelativeHtmlPath && instruction.provider)
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

    const nextHtml = html.includes(managedStartMarker)
      ? html.replace(managedPattern, managedBlock)
      : html.replace("</head>", `${managedBlock}\n</head>`)

    const changedFiles: string[] = []
    if (writeFileIfChanged(appRoot, htmlPath, nextHtml)) {
      changedFiles.push(rootRelativeHtmlPath)
    }

    return {
      changedFiles,
      warnings: []
    }
  },
  uninstall(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const htmlPath = "index.html"
    const rootRelativeHtmlPath = normalizeAppRelativePath(context.appRoot, htmlPath)
    const restoredFiles: string[] = []
    const warnings: string[] = []

    if (!fileExists(appRoot, htmlPath)) {
      warnings.push(`Managed file already absent: ${htmlPath}`)
      return { removedFiles: [], restoredFiles, warnings }
    }

    const html = readRequiredFile(appRoot, htmlPath)
    const managedPattern = new RegExp(
      `${escapeForRegExp(managedStartMarker)}[\\s\\S]*?${escapeForRegExp(managedEndMarker)}\\n?`,
      "m"
    )
    const nextHtml = html.replace(managedPattern, "")
    if (nextHtml === html) {
      warnings.push(`No managed Infinite block found in ${htmlPath}.`)
    } else {
      if (!context.dryRun) {
        writeFileIfChanged(appRoot, htmlPath, nextHtml)
      }
      restoredFiles.push(rootRelativeHtmlPath)
    }

    return { removedFiles: [], restoredFiles, warnings }
  }
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
