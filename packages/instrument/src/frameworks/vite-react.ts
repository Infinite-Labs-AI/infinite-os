import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { FrameworkAdapter } from "../types.js"

import {
  buildAnalyticsModuleSource,
  hasExistingUnmanagedFile,
  isManagedInfiniteFile,
  removeManagedFile
} from "./managed-files.js"
import {
  fileExists,
  firstExistingPath,
  hasDependency,
  normalizeAppRelativePath,
  readRequiredFile,
  writeFileIfChanged
} from "./shared.js"

const mainCandidates = ["src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js"]
const analyticsModulePath = "src/lib/infinite-analytics.ts"
const importLine = 'import { installInfiniteInstrumentation } from "./lib/infinite-analytics"'
const bootLine = "installInfiniteInstrumentation()"

export const viteReactAdapter: FrameworkAdapter = {
  id: "vite-react",
  displayName: "Vite React",
  detect(root) {
    if (!hasDependency(root, "vite") || !hasDependency(root, "react")) {
      return null
    }

    if (!fileExists(root, "index.html")) {
      return null
    }

    const mainFile = firstExistingPath(root, mainCandidates)
    if (!mainFile) {
      return null
    }

    return {
      framework: "vite-react",
      confidence: 0.92,
      files: ["index.html", mainFile, analyticsModulePath],
      assumptions: ["Vite React wiring will target the main entrypoint and index.html."]
    }
  },
  plan(root) {
    const detected = this.detect(root)
    const mainFile = detected?.files[1] ?? "src/main.tsx"

    const blockers: string[] = []
    if (!fileExists(root, mainFile)) {
      blockers.push("Vite React apply requires a src/main.* entrypoint.")
    } else {
      const mainSource = readRequiredFile(root, mainFile)
      if (!mainSource.includes("ReactDOM.createRoot(")) {
        blockers.push(
          "Vite React apply only supports simple main entrypoints with ReactDOM.createRoot()."
        )
      }
      if (findImportSectionEnd(mainSource) === null) {
        blockers.push("Vite React apply requires a simple import block at the top of src/main.*.")
      }
    }
    if (hasExistingUnmanagedFile(root, analyticsModulePath)) {
      blockers.push(
        "Vite React apply will not overwrite an existing unmanaged src/lib/infinite-analytics.ts file."
      )
    }

    return {
      files: ["index.html", mainFile, analyticsModulePath],
      applyMode: blockers.length === 0 ? "supported" : "plan-only",
      instructions:
        blockers.length === 0
          ? [
              {
                path: mainFile,
                action: "modify",
                description:
                  "Import and invoke installInfiniteInstrumentation() once before the React app bootstraps.",
                snippet: `${importLine}\n\n${bootLine}`
              }
            ]
          : [],
      assumptions: [
        "Vite React public IDs can be surfaced through VITE_* environment variables or direct public wiring."
      ],
      blockers,
      confidence: detected?.confidence ?? 0.88
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const mainFile = selectMainFile(appRoot, context.plan.files, context.appRoot)
    const rootRelativeMainFile = normalizeAppRelativePath(context.appRoot, mainFile)
    const rootRelativeAnalyticsFile = normalizeAppRelativePath(context.appRoot, analyticsModulePath)

    const currentMain = readRequiredFile(appRoot, mainFile)
    if (!currentMain.includes("ReactDOM.createRoot(")) {
      throw new Error("Vite React apply only supports simple main entrypoints with ReactDOM.createRoot().")
    }

    const analyticsModuleAbsolutePath = join(appRoot, analyticsModulePath)
    if (
      existsSync(analyticsModuleAbsolutePath) &&
      !isManagedInfiniteFile(readFileSync(analyticsModuleAbsolutePath, "utf8"))
    ) {
      throw new Error(
        `Refusing to overwrite existing unmanaged analytics module at ${rootRelativeAnalyticsFile}.`
      )
    }

    const nextMain = upsertMainEntrypoint(currentMain)
    const nextAnalyticsModule = buildAnalyticsModuleSource(context.plan)

    const changedFiles: string[] = []
    if (writeFileIfChanged(appRoot, mainFile, nextMain)) {
      changedFiles.push(rootRelativeMainFile)
    }
    if (writeFileIfChanged(appRoot, analyticsModulePath, nextAnalyticsModule)) {
      changedFiles.push(rootRelativeAnalyticsFile)
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

    if (hasExistingUnmanagedFile(appRoot, analyticsModulePath)) {
      throw new Error(
        `Refusing to remove ${analyticsModulePath} because it no longer looks managed by Infinite. Remove it manually if it should go.`
      )
    }

    let wiringFullyRemoved = true

    const mainFile = selectMainFile(appRoot, context.manifest.files, context.appRoot)
    const mainAbsolutePath = join(appRoot, mainFile)
    if (!existsSync(mainAbsolutePath)) {
      warnings.push(`Managed main entrypoint already absent: ${mainFile}`)
    } else {
      const currentMain = readFileSync(mainAbsolutePath, "utf8")
      const nextMain = removeMainWiring(currentMain)
      if (nextMain !== currentMain) {
        if (!context.dryRun) {
          writeFileIfChanged(appRoot, mainFile, nextMain)
        }
        restoredFiles.push(normalizeAppRelativePath(context.appRoot, mainFile))
      }
      if (nextMain.includes(importLine) || nextMain.includes(bootLine)) {
        wiringFullyRemoved = false
        warnings.push(
          `Could not remove all instrumentation wiring from ${mainFile} automatically. Remove the leftover lines manually.`
        )
      }
    }

    if (wiringFullyRemoved) {
      const removal = removeManagedFile(appRoot, analyticsModulePath, context.dryRun)
      if (removal.removed) {
        removedFiles.push(normalizeAppRelativePath(context.appRoot, analyticsModulePath))
      }
      if (removal.warning) {
        warnings.push(removal.warning)
      }
    }

    return { removedFiles, restoredFiles, warnings }
  }
}

function removeMainWiring(source: string): string {
  let next = source.replace(`${importLine}\n`, "")
  next = next.replace(`\n${bootLine}\n`, "")
  return next
}

function selectMainFile(root: string, planFiles: string[], appRoot: string): string {
  const appRelativeFiles = planFiles.map((file) =>
    appRoot === "." ? file : file.replace(`${appRoot}/`, "")
  )

  const matched = appRelativeFiles.find((file) => mainCandidates.includes(file))
  if (matched) {
    return matched
  }

  const fallback = firstExistingPath(root, mainCandidates)
  if (!fallback) {
    throw new Error("Unable to resolve the Vite React main entrypoint.")
  }

  return fallback
}

function upsertMainEntrypoint(source: string): string {
  const importSectionEnd = findImportSectionEnd(source)
  if (importSectionEnd === null) {
    throw new Error("Vite React apply requires a simple import block at the top of src/main.*.")
  }

  let next = source
  if (!next.includes(importLine)) {
    next = `${next.slice(0, importSectionEnd)}${importLine}\n${next.slice(importSectionEnd)}`
  }

  if (!next.includes(bootLine)) {
    const refreshedImportSectionEnd = findImportSectionEnd(next)
    if (refreshedImportSectionEnd === null) {
      throw new Error("Unable to refresh the Vite React import block after inserting analytics wiring.")
    }

    next = `${next.slice(0, refreshedImportSectionEnd)}\n${bootLine}\n${next.slice(refreshedImportSectionEnd)}`
  }

  return next
}

// Finds the end offset of the first contiguous import section, treating each
// import statement as complete only once its brackets balance — so multi-line
// imports (`import {\n  a,\n  b\n} from "x"`) are never split mid-statement.
function findImportSectionEnd(source: string): number | null {
  const firstImport = source.match(/^import\b/m)
  if (!firstImport || firstImport.index === undefined) {
    return null
  }

  let position = firstImport.index
  while (isImportKeywordAt(source, position)) {
    const statementEnd = consumeImportStatement(source, position)
    if (statementEnd === null) {
      return null
    }
    position = statementEnd
  }

  return position
}

// Returns true only when "import" at `pos` is a keyword — i.e. not followed
// by an identifier character. This prevents `importantSetup()` from being
// mistaken for an import statement.
function isImportKeywordAt(source: string, pos: number): boolean {
  if (!source.startsWith("import", pos)) {
    return false
  }
  // The character immediately after "import" must not be an identifier char.
  const charAfter = source[pos + 6]
  if (charAfter === undefined) {
    // "import" at end-of-string — not a real import, stop scanning
    return false
  }
  return !/[A-Za-z0-9_$]/.test(charAfter)
}

function consumeImportStatement(source: string, start: number): number | null {
  // Scan character-by-character from the start of the statement, tracking string
  // and comment state so delimiters inside them never affect the bracket depth.
  // The statement ends at the first newline reached with balanced brackets
  // (outside any string/comment), matching multi-line imports like
  // `import {\n  a,\n  b\n} from "x"`. Returns the offset just past that newline,
  // or null if the brackets never balance / a block comment is left unclosed.
  let depth = 0
  let index = start
  let stringQuote: string | null = null
  let inBlockComment = false

  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false
        index += 2
        continue
      }
      index += 1
      continue
    }

    if (stringQuote !== null) {
      if (ch === "\\") {
        index += 2 // skip the escaped character
        continue
      }
      if (ch === stringQuote) {
        stringQuote = null
      }
      index += 1
      continue
    }

    if (ch === "/" && next === "/") {
      // Line comment: jump to the newline, which the newline branch handles.
      const newlineIndex = source.indexOf("\n", index)
      if (newlineIndex === -1) {
        return depth <= 0 ? source.length : null
      }
      index = newlineIndex
      continue
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true
      index += 2
      continue
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      stringQuote = ch
      index += 1
      continue
    }

    if (ch === "{" || ch === "(") {
      depth += 1
    } else if (ch === "}" || ch === ")") {
      depth -= 1
    } else if (ch === "\n" && depth <= 0) {
      return index + 1
    }

    index += 1
  }

  // End of source with no trailing newline.
  if (inBlockComment) {
    return null
  }
  return depth <= 0 ? source.length : null
}
