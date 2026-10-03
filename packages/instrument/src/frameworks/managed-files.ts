import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { nextHelperWrappersSource } from "../conversions/globals.js"
import { jsLiteral } from "../providers/validate.js"
import type { InstallPlan } from "../types.js"

export const managedFileBanner = "// Managed by Infinite. Public install artifacts only."

export function isManagedInfiniteFile(source: string): boolean {
  return source.includes("Managed by Infinite")
}

export function hasExistingUnmanagedFile(root: string, relativePath: string): boolean {
  const absolutePath = join(root, relativePath)
  return existsSync(absolutePath) && !isManagedInfiniteFile(readFileSync(absolutePath, "utf8"))
}

export interface RemoveManagedFileResult {
  removed: boolean
  warning?: string
}

export function removeManagedFile(
  root: string,
  relativePath: string,
  dryRun: boolean
): RemoveManagedFileResult {
  const absolutePath = join(root, relativePath)
  if (!existsSync(absolutePath)) {
    return {
      removed: false,
      warning: `Managed file already absent: ${relativePath}`
    }
  }

  if (!isManagedInfiniteFile(readFileSync(absolutePath, "utf8"))) {
    throw new Error(
      `Refusing to remove ${relativePath} because it no longer looks managed by Infinite. Remove it manually if it should go.`
    )
  }

  if (!dryRun) {
    rmSync(absolutePath)
  }

  return { removed: true }
}

/**
 * One provider's bootstrap, isolated. Next.js joins EVERY provider into ONE inline <script>, so a
 * provider that throws at run time would stop every provider after it (the old PostHog stub did exactly
 * that). Each runs in its own `try`, so a broken provider costs only itself. (A SyntaxError cannot be
 * caught this way; the guard's one-IIFE-per-snippet rule and the vm tests cover that.)
 */
export function isolateProviderSnippet(snippet: string): string {
  return ["try {", snippet, "} catch (_infiniteProviderError) {}"].join("\n")
}

const MANAGED_MODULE_PATH = /(?:^|\/)lib\/infinite-analytics\.(?:ts|js)$/

export function buildAnalyticsModuleSource(plan: InstallPlan): string {
  const forModule = plan.instructions.filter((instruction) => MANAGED_MODULE_PATH.test(instruction.path))
  // The helper globals first, so they exist as early as possible; then each provider, isolated.
  const helperSnippets = forModule
    .filter((instruction) => instruction.helpers === true)
    .map((instruction) => instruction.snippet.trim())
    .filter((snippet) => snippet.length > 0)
  const bootstrapSnippets = forModule
    .filter((instruction) => instruction.provider)
    .map((instruction) => instruction.snippet.trim())
    .filter((snippet) => snippet.length > 0)
    .map(isolateProviderSnippet)

  return [
    managedFileBanner,
    "",
    `const bootstrapSource = ${jsLiteral([...helperSnippets.map(isolateProviderSnippet), ...bootstrapSnippets].join("\n\n"))}`,
    "",
    "export function installInfiniteInstrumentation(): void {",
    '  if (typeof document === "undefined") {',
    "    return",
    "  }",
    "",
    '  if (document.getElementById("infinite-analytics-bootstrap")) {',
    "    return",
    "  }",
    "",
    '  const script = document.createElement("script")',
    '  script.id = "infinite-analytics-bootstrap"',
    '  script.setAttribute("data-infinite-analytics", "managed")',
    "  script.text = bootstrapSource",
    "  document.head.appendChild(script)",
    "}",
    "",
    ...(helperSnippets.length > 0 ? [nextHelperWrappersSource(), ""] : [])
  ].join("\n")
}

export function buildClientComponentSource(
  analyticsImportPath = "./infinite-analytics"
): string {
  return [
    '"use client"',
    "",
    managedFileBanner,
    "",
    'import { useEffect } from "react"',
    `import { installInfiniteInstrumentation } from "${analyticsImportPath}"`,
    "",
    "export function InfiniteAnalyticsClient(): null {",
    "  useEffect(() => {",
    "    installInfiniteInstrumentation()",
    "  }, [])",
    "",
    "  return null",
    "}",
    ""
  ].join("\n")
}
