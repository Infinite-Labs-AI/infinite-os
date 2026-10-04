import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  PackageManager,
  PackageManagerCommands,
  PackageManagerDetection
} from "./types.js"

const lockfileOrder: Array<{ manager: PackageManager; files: string[] }> = [
  { manager: "pnpm", files: ["pnpm-lock.yaml"] },
  { manager: "npm", files: ["package-lock.json"] },
  { manager: "yarn", files: ["yarn.lock"] },
  { manager: "bun", files: ["bun.lock", "bun.lockb"] }
]

interface InstrumentPackageMetadata {
  name: string
  version: string
  private?: boolean
  bin?: Record<string, string>
}

function resolvePackageRoot(): string {
  for (const relativePath of ["..", "../.."]) {
    const candidate = fileURLToPath(new URL(relativePath, import.meta.url))
    if (existsSync(join(candidate, "package.json"))) {
      return candidate
    }
  }

  throw new Error("Unable to resolve the infinite-tag package root.")
}

const packageRoot = resolvePackageRoot()
const instrumentPackage = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8")
) as InstrumentPackageMetadata
const instrumentCliEntry = join(packageRoot, "dist/src/cli.js")
const repoRoot = join(packageRoot, "../..")
const instrumentBinaryName = Object.keys(instrumentPackage.bin ?? {})[0] ?? "infinite-tag"

/** The published infinite-tag version, read from package.json — so CLI guidance + pinned-install
 *  commands always track the real version and never go stale on a bump. */
export const INSTRUMENT_VERSION = instrumentPackage.version

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function buildPublishedCommands(
  manager: PackageManager,
  options: { pinnedVersion: string; workspaceId: string }
): PackageManagerCommands {
  const pinnedPackage = `${instrumentPackage.name}@${options.pinnedVersion}`
  const workspaceFlag = `--workspace ${options.workspaceId}`

  switch (manager) {
    case "npm":
      return {
        packageManager: manager,
        oneOff: `npm exec ${pinnedPackage} -- install ${workspaceFlag}`,
        repeatableInstall: `npm install -D ${pinnedPackage}`,
        repeatableRun: `npm exec ${instrumentBinaryName} -- install ${workspaceFlag}`
      }
    case "pnpm":
      return {
        packageManager: manager,
        oneOff: `pnpm dlx ${pinnedPackage} install ${workspaceFlag}`,
        repeatableInstall: `pnpm add -D ${pinnedPackage}`,
        repeatableRun: `pnpm exec ${instrumentBinaryName} install ${workspaceFlag}`
      }
    case "yarn":
      return {
        packageManager: manager,
        oneOff: `yarn dlx ${pinnedPackage} install ${workspaceFlag}`,
        repeatableInstall: `yarn add -D ${pinnedPackage}`,
        repeatableRun: `yarn ${instrumentBinaryName} install ${workspaceFlag}`
      }
    case "bun":
      return {
        packageManager: manager,
        oneOff: `bunx ${pinnedPackage} install ${workspaceFlag}`,
        repeatableInstall: `bun add -d ${pinnedPackage}`,
        repeatableRun: `bunx ${instrumentBinaryName} install ${workspaceFlag}`
      }
  }
}

function buildLocalWorkspaceCommand(options: { workspaceId: string }): string {
  return [
    `pnpm --dir ${shellQuote(repoRoot)} --filter ${instrumentPackage.name} build`,
    `node ${shellQuote(instrumentCliEntry)} install --root ${shellQuote(repoRoot)} --workspace ${options.workspaceId}`
  ].join(" && ")
}

export function detectPackageManager(
  root: string,
  override?: PackageManager
): PackageManagerDetection {
  if (override) {
    return {
      kind: override,
      reason: "override",
      lockfiles: []
    }
  }

  const matches = lockfileOrder.flatMap((entry) =>
    entry.files
      .filter((file) => existsSync(join(root, file)))
      .map((file) => ({ manager: entry.manager, file }))
  )

  if (matches.length === 0) {
    return {
      kind: "unknown",
      reason: "no-lockfile",
      lockfiles: []
    }
  }

  const uniqueManagers = [...new Set(matches.map((match) => match.manager))]
  if (uniqueManagers.length > 1) {
    return {
      kind: "ambiguous",
      reason: "multiple-lockfiles",
      lockfiles: matches.map((match) => match.file)
    }
  }

  return {
    kind: uniqueManagers[0],
    reason: "lockfile",
    lockfiles: matches.map((match) => match.file)
  }
}

export function buildPackageManagerCommands(
  manager: PackageManager,
  options: { pinnedVersion: string; workspaceId: string }
): PackageManagerCommands {
  const publishedCommands = buildPublishedCommands(manager, options)
  if (instrumentPackage.private !== true) {
    return publishedCommands
  }

  return {
    packageManager: manager,
    oneOff: buildLocalWorkspaceCommand({ workspaceId: options.workspaceId }),
    repeatableInstall: `After publishing ${instrumentPackage.name}, install it with: ${publishedCommands.repeatableInstall}`,
    repeatableRun: `After publishing ${instrumentPackage.name}, re-run it with: ${publishedCommands.repeatableRun}`
  }
}

// ---------------------------------------------------------------------------------------------
// The install-command runner (decision 5: the wizard may npm-install the server-lane package, as its
// own plan line). Exact argv per package manager, never a shell, never a flag from a package name.
// ---------------------------------------------------------------------------------------------

/** A registry package spec: `name`, `@scope/name`, optionally `@<version range>`. Never starts with `-`. */
export const PACKAGE_SPEC_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9.^~<>=*|+-]+)?$/

export interface PackageInstallCommand {
  command: PackageManager
  args: string[]
}

/** The exact argv that adds `packages` as runtime dependencies of the package in the working directory. */
export function packageInstallCommand(manager: PackageManager, packages: readonly string[]): PackageInstallCommand {
  if (packages.length === 0) throw new Error("No packages to install.")
  for (const spec of packages) {
    if (!PACKAGE_SPEC_PATTERN.test(spec) || spec.startsWith("-")) {
      throw new Error(`Refusing to install ${JSON.stringify(spec)}: not a plain registry package name.`)
    }
  }
  switch (manager) {
    case "npm":
      return { command: "npm", args: ["install", ...packages] }
    case "pnpm":
      return { command: "pnpm", args: ["add", ...packages] }
    case "yarn":
      return { command: "yarn", args: ["add", ...packages] }
    case "bun":
      return { command: "bun", args: ["add", ...packages] }
  }
}

/** The one-line form shown on the plan line (`pnpm add @vercel/functions`). */
export function packageInstallCommandLine(manager: PackageManager, packages: readonly string[]): string {
  const { command, args } = packageInstallCommand(manager, packages)
  return [command, ...args].join(" ")
}

export interface CommandRunResult {
  exitCode: number | null
  /** The last few KB of combined output (for the failure line), never parsed for success. */
  outputTail: string
  timedOut: boolean
}

export type CommandSpawner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number }
) => Promise<CommandRunResult>

const OUTPUT_TAIL_BYTES = 4_096

/** The real spawner: no shell, inherited env (the package manager needs PATH, HOME and its config). */
export const spawnCommand: CommandSpawner = (command, args, options) =>
  new Promise((resolveRun) => {
    let tail = ""
    let timedOut = false
    const child = spawn(command, [...args], { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] })
    const keep = (chunk: Buffer) => {
      tail = (tail + chunk.toString("utf8")).slice(-OUTPUT_TAIL_BYTES)
    }
    child.stdout?.on("data", keep)
    child.stderr?.on("data", keep)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, options.timeoutMs)
    child.on("error", (error) => {
      clearTimeout(timer)
      resolveRun({ exitCode: null, outputTail: `${tail}${error.message}`.slice(-OUTPUT_TAIL_BYTES), timedOut })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ exitCode: code, outputTail: tail, timedOut })
    })
  })

export interface RunPackageInstallInput {
  manager: PackageManager
  cwd: string
  packages: readonly string[]
  spawn?: CommandSpawner
  timeoutMs?: number
}

export interface RunPackageInstallResult extends CommandRunResult {
  ok: boolean
  argv: string[]
}

/** Runs the install command once. `ok` only on exit code 0 (and no timeout). */
export async function runPackageInstall(input: RunPackageInstallInput): Promise<RunPackageInstallResult> {
  const { command, args } = packageInstallCommand(input.manager, input.packages)
  const result = await (input.spawn ?? spawnCommand)(command, args, { cwd: input.cwd, timeoutMs: input.timeoutMs ?? 5 * 60_000 })
  return { ...result, ok: result.exitCode === 0 && !result.timedOut, argv: [command, ...args] }
}
