// The npm job (code job C1, decision 5): install the server-lane target's package (e.g.
// `@vercel/functions`) as its OWN plan line, through the repo's own package manager.
//
// It is the only place the wizard touches `package.json` or a lockfile — agents never may (§3e.2).
// Both files are snapshotted as bytes first; on any failure (non-zero exit, timeout, a package.json
// that does not name the package afterwards) both are restored BYTE-IDENTICALLY. On success both are
// recorded as wizard EditRecords so the PR loop stages them (§3g.1) and uninstall can reverse them.
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"

import { runPackageInstall, type CommandSpawner } from "../package-manager.js"
import type { PackageManager } from "../types.js"
import type { WizardEditRecord } from "../wizard/contracts/jobs.js"

import { makeEditRecord } from "./edits.js"

/** The code job id the npm records carry (§3e.1 code jobs). */
export const NPM_JOB_ID = "npm_install" as const

const LOCKFILES: ReadonlyArray<{ manager: PackageManager; file: string; binary: boolean }> = [
  { manager: "pnpm", file: "pnpm-lock.yaml", binary: false },
  { manager: "npm", file: "package-lock.json", binary: false },
  { manager: "yarn", file: "yarn.lock", binary: false },
  { manager: "bun", file: "bun.lock", binary: false },
  { manager: "bun", file: "bun.lockb", binary: true }
]

export interface LockfileLocation {
  manager: PackageManager
  /** Repo-root-relative POSIX path. */
  file: string
}

export type LockfileLookup =
  | { ok: true; lockfile: LockfileLocation }
  | { ok: false; reason: "no_lockfile" | "multiple_lockfiles" | "binary_lockfile"; detail: string }

const toPosix = (path: string): string => path.split(sep).join("/")

/**
 * The lockfile that governs the app: in the app root, else the nearest ancestor up to the repo root
 * (a workspace keeps one lockfile at its root). No lockfile, two kinds in one directory, or a binary
 * one (bun.lockb cannot be recorded as text edits) → no install; the line says why.
 */
export function findLockfile(root: string, appRoot: string): LockfileLookup {
  let directory = appRoot === "." ? root : join(root, appRoot)
  for (;;) {
    const found = LOCKFILES.filter((entry) => existsSync(join(directory, entry.file)))
    if (found.length > 0) {
      const managers = [...new Set(found.map((entry) => entry.manager))]
      if (managers.length > 1) {
        return { ok: false, reason: "multiple_lockfiles", detail: found.map((entry) => entry.file).join(", ") }
      }
      const text = found.find((entry) => !entry.binary)
      if (!text) return { ok: false, reason: "binary_lockfile", detail: found[0]!.file }
      return { ok: true, lockfile: { manager: text.manager, file: toPosix(relative(root, join(directory, text.file))) } }
    }
    if (directory === root) break
    const parent = dirname(directory)
    if (parent === directory || relative(root, parent).startsWith("..")) break
    directory = parent
  }
  return { ok: false, reason: "no_lockfile", detail: "no lockfile in the app root or above it" }
}

export interface NpmJobInput {
  root: string
  appRoot: string
  packages: readonly string[]
  runId: string
  planLineId: string | null
  spawn?: CommandSpawner
  timeoutMs?: number
}

export type NpmJobResult =
  | { ok: true; argv: string[]; edits: WizardEditRecord[] }
  | { ok: false; argv: string[] | null; reason: string; restored: boolean; edits: [] }

function readBytes(path: string): Buffer | null {
  return existsSync(path) ? readFileSync(path) : null
}

/** temp + rename, byte for byte; refuses to write through a symlink (same rule as writeFileAtomic). */
function writeBytesAtomic(path: string, bytes: Buffer): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(`Refusing to write ${path}: it is a symbolic link.`)
  }
  const temp = `${path}.infinite-tag-${process.pid}.tmp`
  writeFileSync(temp, bytes)
  renameSync(temp, path)
}

function restoreBytes(path: string, bytes: Buffer | null): void {
  if (bytes === null) {
    rmSync(path, { force: true })
    return
  }
  const current = readBytes(path)
  if (current !== null && current.equals(bytes)) return
  writeBytesAtomic(path, bytes)
}

function declaresPackage(packageJson: string, spec: string): boolean {
  const name = spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]!
  try {
    const parsed = JSON.parse(packageJson) as Record<string, unknown>
    return ["dependencies", "devDependencies", "optionalDependencies"].some((field) => {
      const deps = parsed[field]
      return typeof deps === "object" && deps !== null && Object.prototype.hasOwnProperty.call(deps, name!)
    })
  } catch {
    return false
  }
}

/** Runs the install; restores package.json + the lockfile byte-identically on any failure. */
export async function runNpmJob(input: NpmJobInput): Promise<NpmJobResult> {
  const lookup = findLockfile(input.root, input.appRoot)
  if (!lookup.ok) {
    return { ok: false, argv: null, reason: `${lookup.reason}: ${lookup.detail}`, restored: false, edits: [] }
  }
  const appRootAbsolute = input.appRoot === "." ? input.root : join(input.root, input.appRoot)
  const packageJsonFile = input.appRoot === "." ? "package.json" : `${input.appRoot}/package.json`
  const packageJsonPath = join(input.root, packageJsonFile)
  const lockfilePath = join(input.root, lookup.lockfile.file)
  if (!existsSync(packageJsonPath)) {
    return { ok: false, argv: null, reason: `no package.json at ${packageJsonFile}`, restored: false, edits: [] }
  }
  const before = { packageJson: readBytes(packageJsonPath), lockfile: readBytes(lockfilePath) }
  const restore = (): boolean => {
    restoreBytes(packageJsonPath, before.packageJson)
    restoreBytes(lockfilePath, before.lockfile)
    const packageJsonBack = readBytes(packageJsonPath)
    const lockfileBack = readBytes(lockfilePath)
    return (
      (before.packageJson === null ? packageJsonBack === null : packageJsonBack !== null && packageJsonBack.equals(before.packageJson)) &&
      (before.lockfile === null ? lockfileBack === null : lockfileBack !== null && lockfileBack.equals(before.lockfile))
    )
  }

  let run: Awaited<ReturnType<typeof runPackageInstall>>
  try {
    run = await runPackageInstall({
      manager: lookup.lockfile.manager,
      cwd: appRootAbsolute,
      packages: input.packages,
      spawn: input.spawn,
      timeoutMs: input.timeoutMs
    })
  } catch (error) {
    return { ok: false, argv: null, reason: error instanceof Error ? error.message : String(error), restored: restore(), edits: [] }
  }
  const after = { packageJson: readBytes(packageJsonPath), lockfile: readBytes(lockfilePath) }
  const failure = !run.ok
    ? run.timedOut
      ? "timed out"
      : `exited ${run.exitCode ?? "without a code"}`
    : after.packageJson === null || !input.packages.every((spec) => declaresPackage(after.packageJson!.toString("utf8"), spec))
      ? "package.json does not name the package afterwards"
      : null
  if (failure) {
    return { ok: false, argv: run.argv, reason: `${run.argv.join(" ")} ${failure}`, restored: restore(), edits: [] }
  }

  const edits: WizardEditRecord[] = []
  const record = (file: string, beforeBytes: Buffer | null, afterBytes: Buffer | null) => {
    if (afterBytes === null) return
    if (beforeBytes !== null && beforeBytes.equals(afterBytes)) return
    edits.push(
      makeEditRecord({
        file,
        before: beforeBytes === null ? null : beforeBytes.toString("utf8"),
        after: afterBytes.toString("utf8"),
        jobId: NPM_JOB_ID,
        planLineId: input.planLineId,
        by: "wizard",
        runId: input.runId
      })
    )
  }
  record(packageJsonFile, before.packageJson, after.packageJson)
  record(lookup.lockfile.file, before.lockfile, after.lockfile)
  return { ok: true, argv: run.argv, edits }
}
