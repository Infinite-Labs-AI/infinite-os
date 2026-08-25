// The server lane on disk: plan → apply → reverse. Called from plan.ts / apply.ts / uninstall.ts
// as a cross-cutting step (it is not a provider and not a framework adapter): for Next.js it creates
// or patches middleware.ts and writes the managed module; for every stack it writes the agent brief.
import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { hasExistingUnmanagedFile, isManagedInfiniteFile, removeManagedFile } from "../frameworks/managed-files.js"
import {
  fileExists,
  firstExistingPath,
  normalizeAppRelativePath,
  readWorkspacePackageJson,
  writeFileIfChanged
} from "../frameworks/shared.js"
import { computeContentHash } from "../manifest.js"
import type {
  InstallManifest,
  ManagedConfigOwnership,
  ServerLaneManifest,
  ServerLanePlan,
  WorkspaceInstallArtifacts
} from "../types.js"

import {
  SERVER_LANE_BRIEF_FILE,
  renderServerLaneBrief,
  type ServerLaneBriefStatus
} from "./copy.js"
import { SERVER_LANE_SECRET_ENV, SERVER_LANE_SOURCE_KEY_ENV } from "./helpers.js"
import { patchExistingMiddleware } from "./middleware-patch.js"
import {
  SERVER_LANE_FENCE_START,
  buildCreatedMiddlewareSource,
  buildServerLaneModuleSource
} from "./runtime-source.js"
import { reverseTextEdits } from "./text-edits.js"

export const SERVER_LANE_ENV_KEYS = [SERVER_LANE_SOURCE_KEY_ENV, SERVER_LANE_SECRET_ENV] as const
export const SERVER_LANE_MODULE_PATH = "lib/infinite-server-lane.ts"
export const SERVER_LANE_MODULE_IMPORT_PATH = "./lib/infinite-server-lane"

/** Existing middleware/proxy files Next.js honours, in lookup order. */
export const NEXT_MIDDLEWARE_CANDIDATES = [
  "middleware.ts",
  "middleware.js",
  "proxy.ts",
  "proxy.js",
  "src/middleware.ts",
  "src/middleware.js",
  "src/proxy.ts",
  "src/proxy.js"
] as const

const NEXT_FRAMEWORKS = new Set(["next-app-router", "next-pages-router"])

export function isNextFramework(framework: string): boolean {
  return NEXT_FRAMEWORKS.has(framework)
}

export interface PlanServerLaneInput {
  root: string
  /** Root-relative app root ("." for the repo root). */
  appRoot: string
  appRootAbsolute: string
  framework: string
  previousManifest: InstallManifest | null
}

export interface ServerLanePlanDraft extends ServerLanePlan {
  blockers: string[]
}

/** Next.js 16 renamed middleware.ts to proxy.ts; older majors keep middleware.ts. */
export function nextMajorVersion(appRootAbsolute: string): number | null {
  const packageJson = readWorkspacePackageJson(appRootAbsolute)
  const spec = packageJson?.dependencies?.next ?? packageJson?.devDependencies?.next
  if (!spec) return null
  const match = /(\d+)\./.exec(spec) ?? /^(\d+)$/.exec(spec.replace(/^[\^~>=<\s]+/, ""))
  return match ? Number(match[1]) : null
}

export function planServerLane(input: PlanServerLaneInput): ServerLanePlanDraft {
  const briefPath = normalizeAppRelativePath(input.appRoot, SERVER_LANE_BRIEF_FILE)
  const envKeys = [...SERVER_LANE_ENV_KEYS]
  const assumptions: string[] = []
  const blockers: string[] = []

  if (!isNextFramework(input.framework)) {
    return {
      mode: "brief",
      briefPath,
      envKeys,
      files: [],
      assumptions: [
        "The server lane is not patched automatically for this stack; the agent brief is the install."
      ],
      blockers
    }
  }

  const existingMiddleware = firstExistingPath(input.appRootAbsolute, [...NEXT_MIDDLEWARE_CANDIDATES])
  const underSrc = existingMiddleware?.startsWith("src/") ?? false
  const modulePath = normalizeAppRelativePath(
    input.appRoot,
    underSrc ? `src/${SERVER_LANE_MODULE_PATH}` : SERVER_LANE_MODULE_PATH
  )
  const middlewareRelative =
    existingMiddleware ??
    ((nextMajorVersion(input.appRootAbsolute) ?? 0) >= 16 ? "proxy.ts" : "middleware.ts")
  const middlewarePath = normalizeAppRelativePath(input.appRoot, middlewareRelative)

  if (hasExistingUnmanagedFile(input.appRootAbsolute, underSrc ? `src/${SERVER_LANE_MODULE_PATH}` : SERVER_LANE_MODULE_PATH)) {
    blockers.push(
      `Server lane apply will not overwrite an existing unmanaged ${modulePath} file.`
    )
  }

  const previousOwnership = input.previousManifest?.configOwnership?.[middlewarePath]
  let middleware: ServerLanePlan["middleware"]
  if (!existingMiddleware) {
    middleware = { path: middlewarePath, action: "create" }
    assumptions.push(`No Next.js middleware exists; ${middlewarePath} will be created with the document matcher.`)
  } else {
    const source = readFileSync(join(input.appRootAbsolute, existingMiddleware), "utf8")
    const currentHash = computeContentHash(source)
    if (previousOwnership?.kind === "created" && isManagedInfiniteFile(source)) {
      // Our own generated file: regenerate idempotently while untouched; keep it once edited.
      if (previousOwnership.installedHash === currentHash) {
        middleware = { path: middlewarePath, action: "create" }
      } else {
        middleware = { path: middlewarePath, action: "keep" }
        assumptions.push(
          `${middlewarePath} was edited after infinite-tag created it; it is left as is and uninstall will refuse to remove it automatically.`
        )
      }
    } else if (source.includes(SERVER_LANE_FENCE_START)) {
      middleware = { path: middlewarePath, action: "keep" }
      if (previousOwnership && previousOwnership.installedHash !== currentHash) {
        assumptions.push(
          `${middlewarePath} was edited after infinite-tag patched it; it is left as is and uninstall will refuse to reverse it automatically.`
        )
      }
    } else {
      const patch = patchExistingMiddleware(source, { moduleImportPath: SERVER_LANE_MODULE_IMPORT_PATH })
      middleware =
        patch.kind === "patched"
          ? { path: middlewarePath, action: "patch" }
          : patch.kind === "already-patched"
            ? { path: middlewarePath, action: "keep" }
            : { path: middlewarePath, action: "unpatchable", reason: patch.reason }
      if (patch.kind === "patched") {
        assumptions.push(
          `${middlewarePath} exists; a fenced infinite-tag block will wrap its handler and the file is reversible via .infinite/install.json.`
        )
      }
      if (patch.kind === "unpatchable") {
        assumptions.push(`${middlewarePath} is left untouched: ${patch.reason}`)
      }
    }
  }

  const managesMiddleware =
    middleware.action === "create" ||
    middleware.action === "patch" ||
    (middleware.action === "keep" && previousOwnership !== undefined)

  return {
    mode: "next-middleware",
    briefPath,
    modulePath,
    middleware,
    envKeys,
    files: [...(managesMiddleware ? [middlewarePath] : []), modulePath],
    assumptions,
    blockers
  }
}

export interface ApplyServerLaneInput {
  root: string
  appRoot: string
  framework: string
  plan: ServerLanePlan
  artifacts: WorkspaceInstallArtifacts
  previousManifest: InstallManifest | null
}

export interface ApplyServerLaneResult {
  changedFiles: string[]
  warnings: string[]
  configOwnership: Record<string, ManagedConfigOwnership>
  manifest: ServerLaneManifest
  /** The rendered brief (also written) so the CLI can print it for non-Next stacks. */
  brief: string
  briefWritten: boolean
}

function toAppRelative(appRoot: string, rootRelative: string): string {
  const prefix = appRoot === "." || appRoot.length === 0 ? "" : `${appRoot}/`
  return prefix && rootRelative.startsWith(prefix) ? rootRelative.slice(prefix.length) : rootRelative
}

export function applyServerLane(input: ApplyServerLaneInput): ApplyServerLaneResult {
  const appRootAbsolute = input.appRoot === "." ? input.root : join(input.root, input.appRoot)
  const changedFiles: string[] = []
  const warnings: string[] = []
  const configOwnership: Record<string, ManagedConfigOwnership> = {}
  const manifest: ServerLaneManifest = { mode: input.plan.mode }
  const siteSourceKey = input.artifacts.infinite?.siteSourceKey || undefined
  const productionHosts =
    input.artifacts.infinite?.productionHosts ?? input.artifacts.productionHosts ?? []

  let status: ServerLaneBriefStatus = { kind: "other-stack", framework: input.framework }

  if (input.plan.mode === "next-middleware" && input.plan.modulePath && input.plan.middleware) {
    const moduleAppRelative = toAppRelative(input.appRoot, input.plan.modulePath)
    if (hasExistingUnmanagedFile(appRootAbsolute, moduleAppRelative)) {
      throw new Error(`Refusing to overwrite existing unmanaged module at ${input.plan.modulePath}.`)
    }
    const moduleSource = buildServerLaneModuleSource({ siteSourceKey, productionHosts })
    if (writeFileIfChanged(appRootAbsolute, moduleAppRelative, moduleSource)) {
      changedFiles.push(input.plan.modulePath)
    }
    manifest.module = input.plan.modulePath

    const middleware = input.plan.middleware
    const middlewareAppRelative = toAppRelative(input.appRoot, middleware.path)
    const middlewareAbsolute = join(appRootAbsolute, middlewareAppRelative)
    const previousOwnership = input.previousManifest?.configOwnership?.[middleware.path]

    switch (middleware.action) {
      case "create": {
        const current = existsSync(middlewareAbsolute) ? readFileSync(middlewareAbsolute, "utf8") : null
        if (current !== null && !isManagedInfiniteFile(current)) {
          throw new Error(`Refusing to overwrite existing unmanaged ${middleware.path}.`)
        }
        if (
          current !== null &&
          previousOwnership?.kind === "created" &&
          previousOwnership.installedHash !== computeContentHash(current)
        ) {
          throw new Error(
            `Refusing to regenerate ${middleware.path} because it changed after Infinite recorded its ownership hash.`
          )
        }
        const contents = buildCreatedMiddlewareSource({ moduleImportPath: SERVER_LANE_MODULE_IMPORT_PATH })
        if (writeFileIfChanged(appRootAbsolute, middlewareAppRelative, contents)) {
          changedFiles.push(middleware.path)
        }
        configOwnership[middleware.path] = { kind: "created", installedHash: computeContentHash(contents) }
        manifest.middleware = middleware.path
        status = { kind: "created", middlewarePath: middleware.path, modulePath: input.plan.modulePath }
        break
      }
      case "patch": {
        const original = readFileSync(middlewareAbsolute, "utf8")
        const patch = patchExistingMiddleware(original, { moduleImportPath: SERVER_LANE_MODULE_IMPORT_PATH })
        if (patch.kind !== "patched") {
          throw new Error(
            `Refusing to patch ${middleware.path}: ${patch.kind === "unpatchable" ? patch.reason : "it changed since planning."}`
          )
        }
        writeFileIfChanged(appRootAbsolute, middlewareAppRelative, patch.contents)
        changedFiles.push(middleware.path)
        configOwnership[middleware.path] = {
          kind: "text-edits",
          originalHash: computeContentHash(original),
          installedHash: computeContentHash(patch.contents),
          edits: patch.edits
        }
        manifest.middleware = middleware.path
        status = { kind: "patched", middlewarePath: middleware.path, modulePath: input.plan.modulePath }
        break
      }
      case "keep": {
        // The brief reflects what the manifest says we did (so re-runs are byte-idempotent), and
        // only reads "kept" when the fence is someone else's.
        status = { kind: "kept", middlewarePath: middleware.path, modulePath: input.plan.modulePath }
        if (previousOwnership) {
          const current = existsSync(middlewareAbsolute) ? readFileSync(middlewareAbsolute, "utf8") : ""
          configOwnership[middleware.path] = previousOwnership
          manifest.middleware = middleware.path
          if (previousOwnership.installedHash !== computeContentHash(current)) {
            warnings.push(
              `${middleware.path} was edited after infinite-tag ${previousOwnership.kind === "created" ? "created" : "patched"} it; uninstall will refuse to reverse it automatically.`
            )
          }
          status = {
            kind: previousOwnership.kind === "created" ? "created" : "patched",
            middlewarePath: middleware.path,
            modulePath: input.plan.modulePath
          }
        }
        break
      }
      case "unpatchable": {
        warnings.push(`${middleware.path} was left untouched: ${middleware.reason ?? "unpatchable"}`)
        status = {
          kind: "unpatchable",
          middlewarePath: middleware.path,
          modulePath: input.plan.modulePath,
          reason: middleware.reason ?? "unpatchable"
        }
        break
      }
    }
  }

  const brief = renderServerLaneBrief({
    status,
    siteSourceKey,
    productionHosts,
    moduleImportPath: SERVER_LANE_MODULE_IMPORT_PATH
  })
  const briefAppRelative = toAppRelative(input.appRoot, input.plan.briefPath)
  let briefWritten = false
  if (hasExistingUnmanagedFile(appRootAbsolute, briefAppRelative)) {
    warnings.push(
      `${input.plan.briefPath} exists and is not managed by Infinite; it was left untouched (the brief is printed instead).`
    )
  } else {
    if (writeFileIfChanged(appRootAbsolute, briefAppRelative, brief)) {
      changedFiles.push(input.plan.briefPath)
    }
    manifest.brief = input.plan.briefPath
    briefWritten = true
  }

  return { changedFiles, warnings, configOwnership, manifest, brief, briefWritten }
}

export interface ReverseServerLaneInput {
  root: string
  manifest: InstallManifest
  dryRun: boolean
}

export interface ReverseServerLaneResult {
  removedFiles: string[]
  restoredFiles: string[]
  warnings: string[]
}

/** Hash-gated reversal: created files are deleted, patched middleware gets its recorded edits undone. */
export function reverseServerLane(input: ReverseServerLaneInput): ReverseServerLaneResult {
  const result: ReverseServerLaneResult = { removedFiles: [], restoredFiles: [], warnings: [] }
  const lane = input.manifest.serverLane
  if (!lane) return result

  if (lane.middleware) {
    const absolute = join(input.root, lane.middleware)
    const ownership = input.manifest.configOwnership?.[lane.middleware]
    if (!existsSync(absolute)) {
      result.warnings.push(`Managed file already absent: ${lane.middleware}`)
    } else if (!ownership) {
      throw new Error(
        `Refusing to uninstall ${lane.middleware} because the manifest has no ownership record for it.`
      )
    } else {
      const current = readFileSync(absolute, "utf8")
      if (ownership.installedHash !== computeContentHash(current)) {
        throw new Error(
          `Refusing to uninstall ${lane.middleware} because it changed after installation. Remove the infinite-tag fenced blocks by hand.`
        )
      }
      if (ownership.kind === "created") {
        if (!input.dryRun) rmSync(absolute)
        result.removedFiles.push(lane.middleware)
      } else if (ownership.kind === "text-edits") {
        const restored = reverseTextEdits(current, ownership.edits)
        if (computeContentHash(restored) !== ownership.originalHash) {
          throw new Error(
            `Refusing to uninstall ${lane.middleware} because reversing the recorded edits did not restore the original hash.`
          )
        }
        if (!input.dryRun) writeFileIfChanged(input.root, lane.middleware, restored)
        result.restoredFiles.push(lane.middleware)
      } else {
        throw new Error(`Unexpected ownership kind for ${lane.middleware}.`)
      }
    }
  }

  if (lane.module) {
    const removal = removeManagedFile(input.root, lane.module, input.dryRun)
    if (removal.removed) result.removedFiles.push(lane.module)
    if (removal.warning) result.warnings.push(removal.warning)
  }

  if (lane.brief) {
    if (!fileExists(input.root, lane.brief)) {
      result.warnings.push(`Managed file already absent: ${lane.brief}`)
    } else if (hasExistingUnmanagedFile(input.root, lane.brief)) {
      result.warnings.push(`${lane.brief} no longer carries the Infinite banner; left in place.`)
    } else {
      if (!input.dryRun) rmSync(join(input.root, lane.brief))
      result.removedFiles.push(lane.brief)
    }
  }

  return result
}
