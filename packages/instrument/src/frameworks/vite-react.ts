import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { FrameworkAdapter, InstallInstruction, InstallManifest, ManualRequirement } from "../types.js"
import { infiniteProxySpec } from "../workspace-artifacts.js"

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
import {
  applyManagedVercelJson,
  buildVercelJson,
  reverseManagedVercelJson,
  VERCEL_CONFIG_FILE,
  VERCEL_HOST_CAVEAT
} from "./vercel-config.js"

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
  plan(root, options) {
    const detected = this.detect(root)
    const mainFile = detected?.files[1] ?? "src/main.tsx"
    const proxy = {
      posthog: options?.posthogProxy,
      infinite: options?.infiniteProxy
    }
    const hasManagedProxy = Boolean(proxy.posthog || proxy.infinite)

    const blockers: string[] = []
    const assumptions: string[] = []
    // The entrypoint edit is broadened + binding-aware, and it never HARD-fails: an entrypoint we
    // cannot safely wire becomes an explicit manual step (the managed module is still written), never
    // a bare abort. Only genuinely unsafe overwrites and the proxy precondition stay hard blockers.
    const wiring: EntrypointWiring = fileExists(root, mainFile)
      ? classifyEntrypointWiring(readRequiredFile(root, mainFile))
      : { kind: "manual", reason: `no ${mainFile} entrypoint was found` }
    // The entrypoint is a managed file only when infinite-tag actually wired it. "already-wired" is
    // kept managed ONLY when a prior manifest recorded it as ours (an idempotent re-run) — a boot line
    // the USER added by hand stays user-owned, so a later legit edit of it never trips verify.
    const previouslyManagedEntry = previousManagedFiles(options?.previousManifest).includes(mainFile)
    const managesEntrypoint =
      wiring.kind === "auto" || (wiring.kind === "already-wired" && previouslyManagedEntry)

    if (hasExistingUnmanagedFile(root, analyticsModulePath)) {
      blockers.push(
        "Vite React apply will not overwrite an existing unmanaged src/lib/infinite-analytics.ts file."
      )
    }
    if (
      proxy.infinite &&
      !options?.allowStaticVercelProxy &&
      !fileExists(root, VERCEL_CONFIG_FILE)
    ) {
      blockers.push(
        "Infinite requires a proven same-origin proxy. Add vercel.json or pass --infinite-static-proxy vercel."
      )
    }

    // The entrypoint is a MANAGED, hash-verified file only when infinite-tag wired it; in the manual
    // case the user owns it, so it is left out of `files` (or verify would flag the lines they add).
    const files = managesEntrypoint
      ? ["index.html", mainFile, analyticsModulePath]
      : ["index.html", analyticsModulePath]
    const instructions: InstallInstruction[] = []
    if (managesEntrypoint) {
      instructions.push({
        path: mainFile,
        action: "modify",
        description:
          "Import and invoke installInfiniteInstrumentation() once before the React app bootstraps.",
        snippet: `${importLine}\n\n${bootLine}`
      })
    } else if (wiring.kind === "manual") {
      // Not a blocker: apply still writes the managed module, then surfaces this exact snippet so the
      // user completes the install by hand. Distinct from a normal edit only in that infinite-tag does
      // not perform it — the boot line itself is the idempotency marker on any re-run.
      instructions.push({
        path: mainFile,
        action: "manual",
        description: `infinite-tag could not safely wire ${mainFile} (${wiring.reason}). Add these two lines by hand, right after your imports (or add the runtime to index.html):`,
        snippet: manualWiringSnippet()
      })
      assumptions.push(
        `${mainFile} could not be wired automatically (${wiring.reason}); the managed module is written and the two wiring lines are surfaced for a manual step.`
      )
    }

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
      assumptions: [
        "Vite React public IDs can be surfaced through VITE_* environment variables or direct public wiring.",
        ...assumptions
      ],
      blockers,
      confidence: detected?.confidence ?? 0.88
    }
  },
  apply(context) {
    const appRoot = context.appRoot === "." ? context.root : join(context.root, context.appRoot)
    const rootRelativeAnalyticsFile = normalizeAppRelativePath(context.appRoot, analyticsModulePath)

    const analyticsModuleAbsolutePath = join(appRoot, analyticsModulePath)
    if (
      existsSync(analyticsModuleAbsolutePath) &&
      !isManagedInfiniteFile(readFileSync(analyticsModuleAbsolutePath, "utf8"))
    ) {
      throw new Error(
        `Refusing to overwrite existing unmanaged analytics module at ${rootRelativeAnalyticsFile}.`
      )
    }

    const changedFiles: string[] = []
    const warnings: string[] = []
    const requiresManual: ManualRequirement[] = []
    const configOwnership = {}

    // Wire the entrypoint when we safely can; otherwise leave it to the user with the exact snippet.
    // The managed module is written either way, so a manual wiring only needs the two import/boot lines.
    // A manual requirement is a STRUCTURED, non-green signal (not just a warning): the install is
    // incomplete until the user adds the lines, so apply/install/verify must not report success.
    const mainFile = mainFileOrNull(appRoot, context.plan.files, context.appRoot)
    if (mainFile) {
      const currentMain = readRequiredFile(appRoot, mainFile)
      const wiring = classifyEntrypointWiring(currentMain)
      const rootRelativeMainFile = normalizeAppRelativePath(context.appRoot, mainFile)
      if (wiring.kind === "auto") {
        const nextMain = upsertMainEntrypoint(currentMain)
        if (writeFileIfChanged(appRoot, mainFile, nextMain)) {
          changedFiles.push(rootRelativeMainFile)
        }
      } else if (wiring.kind === "manual") {
        requiresManual.push({
          path: rootRelativeMainFile,
          reason: wiring.reason,
          snippet: manualWiringSnippet()
        })
      }
      // "already-wired": nothing to change.
    } else {
      requiresManual.push({
        path: normalizeAppRelativePath(context.appRoot, mainCandidates[0]),
        reason: "no src/main.* entrypoint was found",
        snippet: manualWiringSnippet()
      })
    }

    const nextAnalyticsModule = buildAnalyticsModuleSource(context.plan)
    if (writeFileIfChanged(appRoot, analyticsModulePath, nextAnalyticsModule)) {
      changedFiles.push(rootRelativeAnalyticsFile)
    }

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
        Object.assign(configOwnership, { [rootRelativeConfig]: appliedConfig.ownership })
      }
      warnings.push(VERCEL_HOST_CAVEAT)
    }

    return {
      changedFiles,
      warnings,
      configOwnership,
      ...(requiresManual.length > 0 ? { requiresManual } : {})
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
    removedFiles.push(...vercelReversal.removedFiles)
    restoredFiles.push(...vercelReversal.restoredFiles)
    warnings.push(...vercelReversal.warnings)

    return { removedFiles, restoredFiles, warnings }
  }
}

function removeMainWiring(source: string): string {
  let next = source.replace(`${importLine}\n`, "")
  next = next.replace(`\n${bootLine}\n`, "")
  return next
}

/**
 * The main entrypoint to touch, or null when none exists. Unlike selectMainFile it never throws:
 * apply must still write the managed module (and surface a manual step) even with no entrypoint.
 */
function mainFileOrNull(root: string, planFiles: string[], appRoot: string): string | null {
  const appRelativeFiles = planFiles.map((file) =>
    appRoot === "." ? file : file.replace(`${appRoot}/`, "")
  )
  const matched = appRelativeFiles.find((file) => mainCandidates.includes(file))
  if (matched) {
    return matched
  }
  return firstExistingPath(root, mainCandidates)
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

// ---------------------------------------------------------------------------
// React bootstrap recognition (binding-aware).
//
// The injected boot call is inserted right after the import block, INDEPENDENT of how the root is
// created — so recognizing the bootstrap is only a safety gate ("this really is a React entry we can
// wire"), never a positioning input. We accept every real React bootstrap idiom: createRoot (named,
// aliased, default-member, or namespace-member), hydrateRoot, and legacy ReactDOM.render / .render.
//
// It is BINDING-AWARE on purpose: we prove the identifier actually came from an import of
// `react-dom/client` or `react-dom`, so a shadowed local `function createRoot()` or a custom wrapper
// named `render` is NOT mistaken for a React bootstrap. Matching on the bare name would wire the
// wrong file.
const REACT_DOM_SPECIFIERS = new Set(["react-dom/client", "react-dom"])
const BOOTSTRAP_EXPORTS = new Set(["createRoot", "hydrateRoot", "render"])

interface ReactDomBindings {
  /** Locals bound to createRoot/hydrateRoot/render — recognized when called directly (`cr(`). */
  callableLocals: Set<string>
  /** Default or namespace bindings — recognized as `Obj.createRoot(` / `.hydrateRoot(` / `.render(`. */
  memberObjects: Set<string>
}

/**
 * Replace comment bodies (always) and — when `blankStrings` — string/template bodies with spaces,
 * preserving every character offset and newline. This is what makes import + bootstrap detection
 * comment/string-aware: a commented-out `// import { createRoot } from "react-dom/client"` is blanked
 * so it never binds, and a call hidden in a comment or string never counts. Not a full JS parser (no
 * parser dependency, so the self-contained tarball is untouched), but it tracks line comments, block
 * comments and ' " ` strings with escapes — everything a React entrypoint actually contains.
 */
function maskCommentsAndStrings(source: string, blankStrings: boolean): string {
  const out: string[] = []
  let index = 0
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code"
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (state === "code") {
      if (ch === "/" && next === "/") {
        out.push("  ")
        index += 2
        state = "line"
      } else if (ch === "/" && next === "*") {
        out.push("  ")
        index += 2
        state = "block"
      } else if (ch === "'") {
        out.push("'")
        index += 1
        state = "single"
      } else if (ch === '"') {
        out.push('"')
        index += 1
        state = "double"
      } else if (ch === "`") {
        out.push("`")
        index += 1
        state = "template"
      } else {
        out.push(ch)
        index += 1
      }
      continue
    }
    if (state === "line") {
      if (ch === "\n") {
        out.push("\n")
        state = "code"
      } else {
        out.push(" ")
      }
      index += 1
      continue
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        out.push("  ")
        index += 2
        state = "code"
      } else {
        out.push(ch === "\n" ? "\n" : " ")
        index += 1
      }
      continue
    }
    // Inside a string / template literal.
    const closer = state === "single" ? "'" : state === "double" ? '"' : "`"
    if (ch === "\\") {
      out.push(blankStrings ? " " : ch)
      if (next !== undefined) out.push(blankStrings ? " " : next)
      index += 2
      continue
    }
    if (ch === closer) {
      out.push(closer)
      index += 1
      state = "code"
      continue
    }
    out.push(ch === "\n" ? "\n" : blankStrings ? " " : ch)
    index += 1
  }
  return out.join("")
}

function analyzeReactDomBindings(source: string): ReactDomBindings {
  const callableLocals = new Set<string>()
  const memberObjects = new Set<string>()
  // LOCATE import statements on the comment+string+template-masked source, so an import written
  // inside a string or a multiline template literal is never treated as a real import (its whole line
  // is blanked in the mask). The specifier is itself a string — blanked in the mask — so read the
  // genuine clause + specifier from the ORIGINAL source at the match offset (masking preserves length,
  // so offsets are 1:1). Line-anchored (`^…import`) as a second guard.
  const masked = maskCommentsAndStrings(source, true)
  const locateRe = /^[ \t]*import\s+[^;]*?\s+from\s+["'][^"']+["']/gm
  const parseRe = /^[ \t]*import\s+([^;]*?)\s+from\s+["']([^"']+)["']/
  let located: RegExpExecArray | null
  while ((located = locateRe.exec(masked)) !== null) {
    const statement = source.slice(located.index, located.index + located[0].length)
    const parsed = parseRe.exec(statement)
    if (!parsed) continue
    if (!REACT_DOM_SPECIFIERS.has(parsed[2])) continue
    const clause = parsed[1]

    const namedMatch = clause.match(/\{([^}]*)\}/)
    if (namedMatch) {
      for (const raw of namedMatch[1].split(",")) {
        const specifier = raw.trim()
        if (!specifier) continue
        const [imported, local] = specifier.split(/\s+as\s+/).map((part) => part.trim())
        if (BOOTSTRAP_EXPORTS.has(imported)) {
          callableLocals.add(local || imported)
        }
      }
    }

    // Whatever remains once the { … } group is removed is the default and/or namespace binding.
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/^,|,$/g, "")
    for (const raw of rest.split(",")) {
      const part = raw.trim()
      if (!part) continue
      const namespaceMatch = part.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (namespaceMatch) {
        memberObjects.add(namespaceMatch[1])
      } else if (/^[A-Za-z_$][\w$]*$/.test(part)) {
        memberObjects.add(part)
      }
    }
  }
  return { callableLocals, memberObjects }
}

function escapeIdentifierForRegExp(identifier: string): string {
  return identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** True when `source` calls a React bootstrap through an identifier actually imported from react-dom. */
function hasRecognizedReactBootstrap(source: string): boolean {
  const { callableLocals, memberObjects } = analyzeReactDomBindings(source)
  // Detect the CALL in code only: comments AND strings blanked, so a bootstrap call quoted in a
  // string or sitting in a comment never counts as a real bootstrap.
  const code = maskCommentsAndStrings(source, true)
  for (const local of callableLocals) {
    // A direct call `cr(` / `createRoot(` — but not `foo.createRoot(` (that is a member call).
    if (new RegExp(`(^|[^.\\w$])${escapeIdentifierForRegExp(local)}\\s*\\(`, "m").test(code)) {
      return true
    }
  }
  for (const object of memberObjects) {
    if (
      new RegExp(
        `(^|[^.\\w$])${escapeIdentifierForRegExp(object)}\\s*\\.\\s*(createRoot|hydrateRoot|render)\\s*\\(`,
        "m"
      ).test(code)
    ) {
      return true
    }
  }
  return false
}

export type EntrypointWiring =
  | { kind: "auto" }
  | { kind: "already-wired" }
  | { kind: "manual"; reason: string }

/**
 * Whether infinite-tag can safely inject the two wiring lines into `mainSource`, or must hand them to
 * the user. Manageable requires BOTH a recognizable React bootstrap and a simple top-of-file import
 * block (the insertion point). Anything else is a manual install, never a silent skip.
 */
export function classifyEntrypointWiring(mainSource: string): EntrypointWiring {
  if (mainSource.includes(bootLine)) {
    return { kind: "already-wired" }
  }
  const hasBootstrap = hasRecognizedReactBootstrap(mainSource)
  const hasImportBlock = findImportSectionEnd(mainSource) !== null
  if (hasBootstrap && hasImportBlock) {
    return { kind: "auto" }
  }
  if (!hasBootstrap && !hasImportBlock) {
    return {
      kind: "manual",
      reason: "no recognizable React bootstrap (createRoot/hydrateRoot/render from react-dom) and no simple import block were found"
    }
  }
  return {
    kind: "manual",
    reason: hasBootstrap
      ? "the imports at the top are not a simple block infinite-tag can insert after"
      : "no recognizable React bootstrap (createRoot/hydrateRoot/render imported from react-dom) was found"
  }
}

/** The exact lines a user adds by hand when infinite-tag cannot wire the entrypoint automatically. */
export function manualWiringSnippet(): string {
  return `${importLine}\n\n${bootLine}`
}

/** Prior manifest's managed files as app-relative paths (stripping its recorded appRoot prefix). */
function previousManagedFiles(previousManifest: InstallManifest | null | undefined): string[] {
  if (!previousManifest) return []
  const prefix =
    previousManifest.appRoot === "." || previousManifest.appRoot.length === 0
      ? ""
      : `${previousManifest.appRoot}/`
  return previousManifest.files.map((file) =>
    prefix && file.startsWith(prefix) ? file.slice(prefix.length) : file
  )
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
