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
