import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { FrameworkAdapter } from "../types.js"

import {
  buildAnalyticsModuleSource,
  buildClientComponentSource,
  hasExistingUnmanagedFile,
  isManagedInfiniteFile,
  removeManagedFile
} from "./managed-files.js"
import {
  firstExistingPath,
  hasDependency,
  normalizeAppRelativePath,
  readRequiredFile,
  writeFileIfChanged
} from "./shared.js"

const layoutCandidates = [
  "app/layout.tsx",
  "app/layout.ts",
  "app/layout.jsx",
  "app/layout.js"
]
const pageCandidates = ["app/page.tsx", "app/page.ts", "app/page.jsx", "app/page.js"]
const pagesRouterCandidates = [
  "pages/_app.tsx",
  "pages/_app.ts",
  "pages/_app.jsx",
  "pages/_app.js",
  "pages/index.tsx",
  "pages/index.ts",
  "pages/index.jsx",
  "pages/index.js"
]
const layoutFilePath = "app/layout.tsx"
const clientComponentPath = "lib/infinite-analytics-client.tsx"
const analyticsModulePath = "lib/infinite-analytics.ts"
const clientImportLine = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"'
const clientTag = "<InfiniteAnalyticsClient />"
const missingLayoutBlocker =
  "Next.js App Router apply requires a root app/layout.* file so the managed client component can be mounted safely."

export const nextAppRouterAdapter: FrameworkAdapter = {
  id: "next-app-router",
  displayName: "Next.js App Router",
  detect(root) {
    if (!hasDependency(root, "next")) {
      return null
    }

    const layoutFile = firstExistingPath(root, layoutCandidates)
    const pageFile = firstExistingPath(root, pageCandidates)
    if (!layoutFile && !pageFile) {
      return null
    }

    const assumptions = ["Next.js app router wiring will target the app/ tree."]
    if (firstExistingPath(root, pagesRouterCandidates)) {
      assumptions.push(
        "Both app/ and pages/ router trees were detected. App Router wiring was selected; confirm the app/ tree is the active router before applying."
      )
    }

    return {
      framework: "next-app-router",
      confidence: 0.94,
      files: [layoutFile ?? "app/layout.tsx", pageFile ?? "app/page.tsx", "lib/infinite-analytics.ts"],
      assumptions
    }
  },
  plan(root) {
    const detected = this.detect(root)
    const layoutFile = firstExistingPath(root, layoutCandidates)

    if (!layoutFile) {
      return {
        files: [layoutFilePath, clientComponentPath, analyticsModulePath],
        applyMode: "plan-only",
        instructions: [],
        assumptions: ["Next.js app router placement points are inferred from the app/ tree."],
        blockers: [missingLayoutBlocker],
        confidence: detected?.confidence ?? 0.9
      }
    }

    const layoutSource = readRequiredFile(root, layoutFile)
    const blockers: string[] = []
    if (layoutFile !== layoutFilePath) {
      blockers.push(
        "Next.js App Router apply currently supports app/layout.tsx only. Other root layout entrypoints remain plan-only."
      )
    }
    if (!layoutSource.includes("<body")) {
      blockers.push(
        "Next.js App Router apply requires app/layout.tsx to render a <body> element."
      )
    }
    if (hasExistingUnmanagedFile(root, clientComponentPath)) {
      blockers.push(
        "Next.js App Router apply will not overwrite an existing unmanaged lib/infinite-analytics-client.tsx file."
      )
    }
    if (hasExistingUnmanagedFile(root, analyticsModulePath)) {
      blockers.push(
        "Next.js App Router apply will not overwrite an existing unmanaged lib/infinite-analytics.ts file."
      )
    }

    return {
      files: [layoutFilePath, clientComponentPath, analyticsModulePath],
      applyMode: blockers.length === 0 ? "supported" : "plan-only",
      instructions: [
        {
          path: layoutFilePath,
          action: "modify",
          description:
            "Import and mount the managed InfiniteAnalyticsClient from the root app layout.",
          snippet:
            `${clientImportLine}\n\n${clientTag}`
        }
      ],
      assumptions: [
        "Next.js app router placement points are inferred from the app/ tree."
      ],
      blockers,
      confidence: detected?.confidence ?? 0.9
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const currentLayout = readRequiredFile(appRoot, layoutFilePath)
    if (!currentLayout.includes("<body")) {
      throw new Error("Next.js App Router apply requires app/layout.tsx to render a <body> element.")
    }

    const analyticsModuleAbsolutePath = join(appRoot, analyticsModulePath)
    if (
      existsSync(analyticsModuleAbsolutePath) &&
      !isManagedInfiniteFile(readFileSync(analyticsModuleAbsolutePath, "utf8"))
    ) {
      throw new Error(
        "Refusing to overwrite existing unmanaged analytics module at lib/infinite-analytics.ts."
      )
    }

    const clientComponentAbsolutePath = join(appRoot, clientComponentPath)
    if (
      existsSync(clientComponentAbsolutePath) &&
      !isManagedInfiniteFile(readFileSync(clientComponentAbsolutePath, "utf8"))
    ) {
      throw new Error(
        "Refusing to overwrite existing unmanaged client component at lib/infinite-analytics-client.tsx."
      )
    }

    const nextLayout = upsertLayoutSource(currentLayout)
    const nextClientComponent = buildClientComponentSource()
    const nextAnalyticsModule = buildAnalyticsModuleSource(context.plan)

    const changedFiles: string[] = []
    if (writeFileIfChanged(appRoot, layoutFilePath, nextLayout)) {
      changedFiles.push(normalizeAppRelativePath(context.appRoot, layoutFilePath))
    }
    if (writeFileIfChanged(appRoot, clientComponentPath, nextClientComponent)) {
      changedFiles.push(normalizeAppRelativePath(context.appRoot, clientComponentPath))
    }
    if (writeFileIfChanged(appRoot, analyticsModulePath, nextAnalyticsModule)) {
      changedFiles.push(normalizeAppRelativePath(context.appRoot, analyticsModulePath))
    }

    return {
      changedFiles,
      warnings: []
    }
  },
  uninstall(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const removedFiles: string[] = []
    const restoredFiles: string[] = []
    const warnings: string[] = []

    for (const managedPath of [clientComponentPath, analyticsModulePath]) {
      if (hasExistingUnmanagedFile(appRoot, managedPath)) {
        throw new Error(
          `Refusing to remove ${managedPath} because it no longer looks managed by Infinite. Remove it manually if it should go.`
        )
      }
    }

    let wiringFullyRemoved = true

    const layoutAbsolutePath = join(appRoot, layoutFilePath)
    if (!existsSync(layoutAbsolutePath)) {
      warnings.push(`Managed layout already absent: ${layoutFilePath}`)
    } else {
      const currentLayout = readFileSync(layoutAbsolutePath, "utf8")
      const nextLayout = removeLayoutWiring(currentLayout)
      if (nextLayout !== currentLayout) {
        if (!context.dryRun) {
          writeFileIfChanged(appRoot, layoutFilePath, nextLayout)
        }
        restoredFiles.push(normalizeAppRelativePath(context.appRoot, layoutFilePath))
      }
      if (nextLayout.includes(clientImportLine) || nextLayout.includes(clientTag)) {
        wiringFullyRemoved = false
        warnings.push(
          `Could not remove all InfiniteAnalyticsClient wiring from ${layoutFilePath} automatically. Remove the leftover lines manually.`
        )
      }
    }

    if (wiringFullyRemoved) {
      for (const managedPath of [clientComponentPath, analyticsModulePath]) {
        const removal = removeManagedFile(appRoot, managedPath, context.dryRun)
        if (removal.removed) {
          removedFiles.push(normalizeAppRelativePath(context.appRoot, managedPath))
        }
        if (removal.warning) {
          warnings.push(removal.warning)
        }
      }
    }

    return { removedFiles, restoredFiles, warnings }
  }
}

function removeLayoutWiring(source: string): string {
  let next = source.replace(`${clientImportLine}\n`, "")
  next = next.replace(`\n        ${clientTag}`, "")
  return next
}

function upsertLayoutSource(source: string): string {
  let next = source
  if (!next.includes(clientImportLine)) {
    next = `${clientImportLine}\n${next}`
  }

  if (!next.includes(clientTag)) {
    next = next.replace(/<body\b[^>]*>/, (match) => `${match}\n        ${clientTag}`)
  }

  return next
}
