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
