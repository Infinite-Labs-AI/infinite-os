import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import type { InstallPlan } from "../types.js"

const managedFileBanner = "// Managed by Infinite. Public install artifacts only."

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

export function buildAnalyticsModuleSource(plan: InstallPlan): string {
  const bootstrapSnippets = plan.instructions
    .filter(
      (instruction) =>
        instruction.provider &&
        /(?:^|\/)lib\/infinite-analytics\.(?:ts|js)$/.test(instruction.path)
    )
    .map((instruction) => instruction.snippet.trim())
    .filter((snippet) => snippet.length > 0)

  const ga4MeasurementId = plan.artifacts.ga4?.measurementId
  const externalScripts =
    typeof ga4MeasurementId === "string" && ga4MeasurementId.length > 0
      ? [
          {
            id: "infinite-ga4-loader",
            src: `https://www.googletagmanager.com/gtag/js?id=${ga4MeasurementId}`,
            async: true
          }
        ]
      : []

  return [
    managedFileBanner,
    "",
    `const externalScripts = ${JSON.stringify(externalScripts, null, 2)} as const`,
    "",
    "const bootstrapSource = String.raw`",
    bootstrapSnippets.join("\n\n"),
    "`",
    "",
    "function ensureExternalScript(id: string, src: string, isAsync: boolean): void {",
    '  if (document.querySelector(`script[data-infinite-id="${id}"]`)) {',
    "    return",
    "  }",
    "",
    '  const script = document.createElement("script")',
    "  script.src = src",
    "  script.async = isAsync",
    '  script.setAttribute("data-infinite-id", id)',
    "  document.head.appendChild(script)",
    "}",
    "",
    "export function installInfiniteInstrumentation(): void {",
    '  if (typeof document === "undefined") {',
    "    return",
    "  }",
    "",
    "  for (const scriptSpec of externalScripts) {",
    "    ensureExternalScript(scriptSpec.id, scriptSpec.src, scriptSpec.async)",
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
    ""
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
