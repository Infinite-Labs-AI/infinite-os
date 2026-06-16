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

const appCandidates = ["pages/_app.tsx", "pages/_app.ts", "pages/_app.jsx", "pages/_app.js"]
const indexCandidates = ["pages/index.tsx", "pages/index.ts", "pages/index.jsx", "pages/index.js"]
const appFilePath = "pages/_app.tsx"
const clientComponentPath = "lib/infinite-analytics-client.tsx"
const analyticsModulePath = "lib/infinite-analytics.ts"
const clientImportLine = 'import { InfiniteAnalyticsClient } from "../lib/infinite-analytics-client"'
const clientTag = "<InfiniteAnalyticsClient />"
const missingAppBlocker =
  "Next.js Pages Router apply requires pages/_app.* so the managed client component can be mounted safely."

export const nextPagesRouterAdapter: FrameworkAdapter = {
  id: "next-pages-router",
  displayName: "Next.js Pages Router",
  detect(root) {
    if (!hasDependency(root, "next")) {
      return null
    }

    const appFile = firstExistingPath(root, appCandidates)
    const indexFile = firstExistingPath(root, indexCandidates)
    if (!appFile && !indexFile) {
      return null
    }

    return {
      framework: "next-pages-router",
      confidence: 0.9,
      files: [appFile ?? "pages/_app.tsx", indexFile ?? "pages/index.tsx", "lib/infinite-analytics.ts"],
      assumptions: ["Next.js pages router wiring will target pages/_app.*."]
    }
  },
  plan(root) {
    const detected = this.detect(root)
    const appFile = firstExistingPath(root, appCandidates)

    if (!appFile) {
      return {
        files: [appFilePath, clientComponentPath, analyticsModulePath],
        applyMode: "plan-only",
        instructions: [],
        assumptions: ["Next.js pages router wiring will target pages/_app.*."],
        blockers: [missingAppBlocker],
        confidence: detected?.confidence ?? 0.88
      }
    }

    const appSource = readRequiredFile(root, appFile)
    const componentMatches = appSource.match(/<Component\b[^>]*\/>/g) ?? []
    const blockers: string[] = []
    if (appFile !== appFilePath) {
      blockers.push(
        "Next.js Pages Router apply currently supports pages/_app.tsx only. Other custom App entrypoints remain plan-only."
      )
    }
    if (componentMatches.length !== 1) {
      blockers.push(
        "Next.js Pages Router apply requires pages/_app.tsx to render <Component {...pageProps} /> exactly once."
      )
    }
    if (hasExistingUnmanagedFile(root, clientComponentPath)) {
      blockers.push(
        "Next.js Pages Router apply will not overwrite an existing unmanaged lib/infinite-analytics-client.tsx file."
      )
    }
    if (hasExistingUnmanagedFile(root, analyticsModulePath)) {
      blockers.push(
        "Next.js Pages Router apply will not overwrite an existing unmanaged lib/infinite-analytics.ts file."
      )
    }

    return {
      files: [appFilePath, clientComponentPath, analyticsModulePath],
      applyMode: blockers.length === 0 ? "supported" : "plan-only",
      instructions: [
        {
          path: appFilePath,
          action: "modify",
          description:
            "Import and mount the managed InfiniteAnalyticsClient from pages/_app.tsx.",
          snippet:
            `${clientImportLine}\n\n${clientTag}`
        }
      ],
      assumptions: [
        "Next.js pages router placement points are inferred from the pages/ tree."
      ],
      blockers,
      confidence: detected?.confidence ?? 0.88
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const currentApp = readRequiredFile(appRoot, appFilePath)
    if ((currentApp.match(/<Component\b[^>]*\/>/g) ?? []).length !== 1) {
      throw new Error(
        "Next.js Pages Router apply requires pages/_app.tsx to render <Component {...pageProps} /> exactly once."
      )
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

    const nextApp = upsertAppSource(currentApp)
    const nextClientComponent = buildClientComponentSource()
    const nextAnalyticsModule = buildAnalyticsModuleSource(context.plan)

    const changedFiles: string[] = []
    if (writeFileIfChanged(appRoot, appFilePath, nextApp)) {
      changedFiles.push(normalizeAppRelativePath(context.appRoot, appFilePath))
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

    const appAbsolutePath = join(appRoot, appFilePath)
    if (!existsSync(appAbsolutePath)) {
      warnings.push(`Managed app entrypoint already absent: ${appFilePath}`)
    } else {
      const currentApp = readFileSync(appAbsolutePath, "utf8")
      const nextApp = removeAppWiring(currentApp)
      if (nextApp !== currentApp) {
        if (!context.dryRun) {
          writeFileIfChanged(appRoot, appFilePath, nextApp)
        }
        restoredFiles.push(normalizeAppRelativePath(context.appRoot, appFilePath))
      }
      if (nextApp.includes(clientImportLine) || nextApp.includes(clientTag)) {
        wiringFullyRemoved = false
        warnings.push(
          `Could not remove all InfiniteAnalyticsClient wiring from ${appFilePath} automatically. Remove the leftover lines manually.`
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

function removeAppWiring(source: string): string {
  let next = source.replace(`${clientImportLine}\n`, "")
  next = next.replace(
    /<>\n {6}<InfiniteAnalyticsClient \/>\n {6}(<Component\b[^>]*\/>)\n {4}<\/>/,
    (_match, component: string) => component
  )
  return next
}

function upsertAppSource(source: string): string {
  let next = source
  if (!next.includes(clientImportLine)) {
    next = `${clientImportLine}\n${next}`
  }

  if (!next.includes(clientTag)) {
    next = next.replace(
      /<Component\b[^>]*\/>/,
      (match) => `<>\n      ${clientTag}\n      ${match}\n    </>`
    )
  }

  return next
}
