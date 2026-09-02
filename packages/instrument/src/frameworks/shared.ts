import { randomBytes } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

interface WorkspacePackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function fileExists(root: string, relativePath: string): boolean {
  return existsSync(join(root, relativePath))
}

export function firstExistingPath(root: string, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fileExists(root, candidate)) {
      return candidate
    }
  }

  return null
}

export function readWorkspacePackageJson(root: string): WorkspacePackageJson | null {
  const packageJsonPath = join(root, "package.json")
  if (!existsSync(packageJsonPath)) {
    return null
  }

  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as WorkspacePackageJson
}

export function hasDependency(root: string, dependencyName: string): boolean {
  const packageJson = readWorkspacePackageJson(root)
  if (!packageJson) {
    return false
  }

  return Boolean(
    packageJson.dependencies?.[dependencyName] ?? packageJson.devDependencies?.[dependencyName]
  )
}

export function readRequiredFile(root: string, relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8")
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function escapesRoot(root: string, target: string): boolean {
  const relativePath = relative(root, target)
  return relativePath.startsWith("..") || isAbsolute(relativePath)
}

// Realpath the deepest existing ancestor, then re-append the missing tail, so
// non-existent paths still compare correctly when the root itself sits behind
// a symlink (e.g. macOS /var/folders -> /private/var/folders).
function realpathNearestExistingAncestor(path: string): string {
  let current = path
  const missingTail: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    missingTail.unshift(basename(current))
    current = parent
  }

  return join(realpathOrSelf(current), ...missingTail)
}

export function resolveConfinedAppRoot(root: string, appRoot: string): string {
  const resolvedRoot = resolve(root)
  const resolvedAppRoot = resolve(resolvedRoot, appRoot)
  if (escapesRoot(resolvedRoot, resolvedAppRoot)) {
    throw new Error(
      `Refusing to use app root "${appRoot}" because it escapes the workspace root.`
    )
  }

  if (
    escapesRoot(realpathOrSelf(resolvedRoot), realpathNearestExistingAncestor(resolvedAppRoot))
  ) {
    throw new Error(
      `Refusing to use app root "${appRoot}" because it resolves outside the workspace root through a symlink.`
    )
  }

  return resolvedAppRoot
}

export function assertConfinedManifestFileEntry(root: string, relativePath: string): void {
  if (isAbsolute(relativePath)) {
    throw new Error(
      `Refusing to use manifest file entry "${relativePath}" because absolute paths are not allowed.`
    )
  }

  const resolvedRoot = resolve(root)
  if (escapesRoot(resolvedRoot, resolve(resolvedRoot, relativePath))) {
    throw new Error(
      `Refusing to use manifest file entry "${relativePath}" because it escapes the workspace root.`
    )
  }
}

export function assertWriteTargetInsideRoot(root: string, absolutePath: string): void {
  const resolvedRoot = resolve(root)
  const resolvedTarget = resolve(absolutePath)
  if (escapesRoot(resolvedRoot, resolvedTarget)) {
    throw new Error(
      `Refusing to write outside the workspace root: ${absolutePath}`
    )
  }

  let nearestExistingAncestor = dirname(resolvedTarget)
  while (!existsSync(nearestExistingAncestor)) {
    const parent = dirname(nearestExistingAncestor)
    if (parent === nearestExistingAncestor) {
      break
    }
    nearestExistingAncestor = parent
  }

  if (escapesRoot(realpathOrSelf(resolvedRoot), realpathOrSelf(nearestExistingAncestor))) {
    throw new Error(
      `Refusing to write through a path that resolves outside the workspace root: ${absolutePath}`
    )
  }
}

export function writeFileIfChanged(root: string, relativePath: string, contents: string): boolean {
  const absolutePath = join(root, relativePath)
  assertWriteTargetInsideRoot(root, absolutePath)
  const existing = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : null
  if (existing === contents) {
    return false
  }

  writeFileAtomic(absolutePath, contents)
  return true
}

export function writeFileAtomic(absolutePath: string, contents: string): void {
  const stats = lstatSync(absolutePath, { throwIfNoEntry: false })
  if (stats?.isSymbolicLink()) {
    throw new Error(
      `Refusing to write through a symlink at ${absolutePath}. Replace the symlink with a regular file first.`
    )
  }

  mkdirSync(dirname(absolutePath), { recursive: true })
  const tempPath = `${absolutePath}.${randomBytes(6).toString("hex")}.tmp`
  try {
    writeFileSync(tempPath, contents)
    renameSync(tempPath, absolutePath)
  } catch (error) {
    rmSync(tempPath, { force: true })
    throw error
  }
}

export function indentBlock(source: string, spaces: number): string {
  const prefix = " ".repeat(spaces)
  return source
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : line))
    .join("\n")
}

export function normalizeAppRelativePath(appRoot: string, relativePath: string): string {
  if (appRoot === "." || appRoot.length === 0) {
    return relativePath
  }

  return `${appRoot}/${relativePath}`
}

/**
 * Replace comment bodies (always) and — when `blankStrings` — string/template bodies with spaces,
 * preserving every character offset and newline. A bounded scanner for "is this token really in
 * CODE, not a comment or a string?" — it tracks line comments, block comments and ' " ` strings with
 * escapes. It does NO binding/scope analysis, so it is not the tarpit the bootstrap scanner was.
 *
 * Used by the provider-evidence scan so a commented-out or in-string `posthog.init(` / `gtag(` /
 * `fbq(` / `twq(` is not mistaken for a real install (which would silently ADOPT — and suppress —
 * the provider). Pass `blankStrings: false` to blank only comments (keep string bodies) when the
 * evidence legitimately lives in a string, e.g. a host URL or an import specifier.
 */
export function maskCommentsAndStrings(source: string, blankStrings: boolean): string {
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
