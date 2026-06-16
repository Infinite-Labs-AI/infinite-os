#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { createInterface } from "node:readline"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { applyInstallation } from "./apply.js"
import { isSupportedFramework } from "./frameworks/index.js"
import { inspectWorkspace } from "./inspect.js"
import { buildPackageManagerCommands } from "./package-manager.js"
import { planInstallation } from "./plan.js"
import {
  renderApplied,
  renderBlocked,
  renderInspect,
  renderNoArtifacts,
  renderPreview,
  renderUninstall,
  renderUnsupported,
  renderVerify
} from "./render.js"
import type { InstallPlan, PackageManager, PackageManagerDetectionKind } from "./types.js"
import { uninstallInstallation } from "./uninstall.js"
import {
  defaultArtifactsDir,
  discoverWorkspaceArtifacts,
  resolveWorkspaceArtifacts
} from "./workspace-artifacts.js"
import { verifyInstallation } from "./verify.js"

interface ParsedArgs {
  command: string
  root?: string
  workspaceId?: string
  appRoot?: string
  json: boolean
  yes: boolean
  allowDirty: boolean
  artifactFile?: string
  ga4MeasurementId?: string
  posthogProjectKey?: string
  posthogApiHost?: string
  xPixelId?: string
  xEventTagIds: string[]
  packageManager?: PackageManager
}

const NO_ARTIFACTS_BLOCKER = "No supported public install artifacts were provided."

function parsePackageManager(value: string): PackageManager {
  if (value === "pnpm" || value === "npm" || value === "yarn" || value === "bun") {
    return value
  }

  throw new Error(`Unsupported package manager override: ${value}`)
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(
      `Missing value for ${flag}.${value !== undefined ? ` (got "${value}" — values beginning with -- are treated as a missing value)` : ""}`
    )
  }

  return value
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: argv[0] ?? "help",
    json: false,
    yes: false,
    allowDirty: false,
    xEventTagIds: []
  }

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]
    const next = argv[index + 1]

    switch (token) {
      case "--root":
        parsed.root = requireValue(token, next)
        index += 1
        break
      case "--workspace":
        parsed.workspaceId = requireValue(token, next)
        index += 1
        break
      case "--app-root":
        parsed.appRoot = requireValue(token, next)
        index += 1
        break
      case "--artifact-file":
        parsed.artifactFile = requireValue(token, next)
        index += 1
        break
      case "--ga4-measurement-id":
        parsed.ga4MeasurementId = requireValue(token, next)
        index += 1
        break
      case "--posthog-project-key":
        parsed.posthogProjectKey = requireValue(token, next)
        index += 1
        break
      case "--posthog-api-host":
        parsed.posthogApiHost = requireValue(token, next)
        index += 1
        break
      case "--x-pixel-id":
        parsed.xPixelId = requireValue(token, next)
        index += 1
        break
      case "--x-event-tag-id":
        parsed.xEventTagIds.push(requireValue(token, next))
        index += 1
        break
      case "--package-manager":
        parsed.packageManager = parsePackageManager(requireValue(token, next))
        index += 1
        break
      case "--json":
        parsed.json = true
        break
      case "--yes":
        parsed.yes = true
        break
      case "--allow-dirty":
        parsed.allowDirty = true
        break
      default:
        throw new Error(`Unknown argument: ${token}. Run infinite-tag help for usage.`)
    }
  }

  return parsed
}

function printResult(_parsed: ParsedArgs, value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

function printHelp(): void {
  console.log(
    [
      "Usage: infinite-tag <inspect|plan|apply|verify|install|uninstall> [options]",
      "",
      "Commands:",
      "  inspect       Detect framework, app root, package manager, and existing providers",
      "  plan          Produce a deterministic install plan from public provider artifacts",
      "  apply         Apply the plan to your repo and record .infinite/install.json",
      "  verify        Verify managed analytics files match the recorded manifest",
      "  install       Inspect -> plan -> (confirm) -> apply -> verify",
      "  uninstall     Remove the managed install recorded in .infinite/install.json",
      "                (dry run without --yes; destructive with --yes)",
      "",
      "Common flags:",
      "  --root <path>",
      "  --yes             Apply without the interactive confirmation",
      "  --allow-dirty     Skip the clean-git-tree safety gate",
      "  --json            Output machine-readable JSON instead of human text",
      "",
      "Artifact flags:",
      "  --ga4-measurement-id <id>",
      "  --posthog-project-key <key>",
      "  --posthog-api-host <host>",
      "  --x-pixel-id <id>",
      "  --x-event-tag-id <id>  (repeatable)",
      "  --artifact-file <path>",
      "",
      "When no artifact flags and no --artifact-file are given, plan/apply/install",
      "auto-discover the file `infinite setup` saved under ~/.infinite/artifacts/",
      "(<workspace>.json with --workspace; a single saved file otherwise, adopting",
      "its workspace id). Explicit flags always win."
    ].join("\n")
  )
}

function detectedManagerFromInspect(packageManager: string): PackageManager | undefined {
  if (
    packageManager === "pnpm" ||
    packageManager === "npm" ||
    packageManager === "yarn" ||
    packageManager === "bun"
  ) {
    return packageManager
  }

  return undefined
}

function maybePrintCommands(
  command: string,
  packageManager: PackageManagerDetectionKind,
  workspaceId?: string
): void {
  const resolved = detectedManagerFromInspect(packageManager)
  if (!resolved || !workspaceId) {
    return
  }

  const commands = buildPackageManagerCommands(resolved, {
    pinnedVersion: "0.1.2",
    workspaceId
  })
  if (command === "inspect" || command === "verify") {
    return
  }

  console.error(`Suggested one-off command: ${commands.oneOff}`)
}

/** Classifies why a plan can't be applied, so human mode can show the right guidance. */
function planIssue(plan: InstallPlan): "unsupported" | "no-artifacts" | "blocked" | null {
  if (!isSupportedFramework(plan.framework)) {
    return "unsupported"
  }
  if (plan.blockers.includes(NO_ARTIFACTS_BLOCKER)) {
    return "no-artifacts"
  }
  if (plan.blockers.length > 0) {
    return "blocked"
  }
  return null
}

/** Renders the appropriate "can't install" message for human mode; null when the plan is clean. */
function renderPlanIssue(plan: InstallPlan): string | null {
  switch (planIssue(plan)) {
    case "unsupported":
      return renderUnsupported(plan)
    case "no-artifacts":
      return renderNoArtifacts(defaultArtifactsDir())
    case "blocked":
      return renderBlocked(plan)
    default:
      return null
  }
}

/** Interactive [Y/n] confirmation on stderr, defaulting to yes. Only call in a TTY. */
async function confirmApply(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise<string>((resolveAnswer) => {
      rl.question("Apply these changes? [Y/n] ", resolveAnswer)
    })
    const normalized = answer.trim().toLowerCase()
    return normalized === "" || normalized === "y" || normalized === "yes"
  } finally {
    rl.close()
  }
}

interface ApplyContext {
  root: string
  inspect: ReturnType<typeof inspectWorkspace>
  plan: InstallPlan
  allowDirty: boolean
}

/** Applies + verifies, then prints the human narration/success block. Returns the exit code. */
function applyAndRenderHuman(ctx: ApplyContext): number {
  if (ctx.plan.repoStatus === "dirty" && !ctx.allowDirty) {
    console.log(
      "\nYour git tree has uncommitted changes. Commit or stash them first so you can review" +
        "\nexactly what Infinite adds — or re-run with --allow-dirty to proceed anyway.\n"
    )
    return 1
  }

  const applyResult = applyInstallation({
    root: ctx.root,
    workspaceId: ctx.plan.workspaceId as string,
    plan: ctx.plan,
    allowDirty: ctx.allowDirty
  })
  const verifyResult = verifyInstallation({ root: ctx.root })
  console.log(renderApplied({ inspect: ctx.inspect, plan: ctx.plan, apply: applyResult, verify: verifyResult }))
  return verifyResult.buildOk ? 0 : 1
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseArgs(argv)
    if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
      printHelp()
      return 0
    }

    const root = resolve(parsed.root ?? process.cwd())

    if (parsed.command === "uninstall") {
      const result = uninstallInstallation({
        root,
        allowDirty: parsed.allowDirty,
        dryRun: !parsed.yes
      })
      if (parsed.json) {
        printResult(parsed, result)
      } else {
        console.log(renderUninstall(result, !parsed.yes))
      }
      if (!parsed.yes) {
        console.error("Dry run only. Re-run uninstall with --yes to remove the managed install.")
      }
      return 0
    }

    const inspect = inspectWorkspace(root, {
      appRoot: parsed.appRoot,
      packageManager: parsed.packageManager
    })
    let artifacts = resolveWorkspaceArtifacts(root, {
      artifactFile: parsed.artifactFile,
      ga4MeasurementId: parsed.ga4MeasurementId,
      posthogProjectKey: parsed.posthogProjectKey,
      posthogApiHost: parsed.posthogApiHost,
      xPixelId: parsed.xPixelId,
      xEventTagIds: parsed.xEventTagIds
    })

    // Same-machine flag-free install: with no artifact flags and no --artifact-file,
    // fall back to the public artifacts `infinite setup` saved on this machine.
    // Explicit artifact input always wins, and a workspace id adopted from the
    // discovered file satisfies the `install --yes` workspace requirement.
    const hasExplicitArtifacts =
      parsed.artifactFile !== undefined ||
      parsed.ga4MeasurementId !== undefined ||
      parsed.posthogProjectKey !== undefined ||
      parsed.posthogApiHost !== undefined ||
      parsed.xPixelId !== undefined ||
      parsed.xEventTagIds.length > 0
    const commandUsesArtifacts =
      parsed.command === "plan" || parsed.command === "apply" || parsed.command === "install"
    if (commandUsesArtifacts && !hasExplicitArtifacts) {
      const discovered = discoverWorkspaceArtifacts({
        workspaceId: parsed.workspaceId,
        warn: (message) => console.error(message)
      })
      if (discovered) {
        artifacts = discovered.artifacts
        const adoptedWorkspaceId =
          parsed.workspaceId === undefined ? discovered.workspaceId : undefined
        if (adoptedWorkspaceId !== undefined) {
          parsed.workspaceId = adoptedWorkspaceId
        }
        console.error(
          `Discovered saved public artifacts: ${discovered.filePath} (providers: ${discovered.providers.join(", ")}${
            adoptedWorkspaceId !== undefined ? `; workspace: ${adoptedWorkspaceId}` : ""
          })`
        )
      }
    }

    switch (parsed.command) {
      case "inspect":
        if (parsed.json) {
          printResult(parsed, inspect)
        } else {
          console.log(renderInspect(inspect))
        }
        return 0
      case "plan": {
        const plan = planInstallation({
          root,
          inspect,
          workspaceId: parsed.workspaceId,
          packageManager: parsed.packageManager,
          artifacts
        })
        if (parsed.json) {
          printResult(parsed, plan)
          maybePrintCommands(parsed.command, inspect.packageManager as PackageManagerDetectionKind, parsed.workspaceId)
          return plan.blockers.length === 0 ? 0 : 1
        }
        const issue = renderPlanIssue(plan)
        if (issue) {
          console.log(issue)
          return plan.blockers.length === 0 ? 0 : 1
        }
        console.log(renderPreview(plan))
        console.log("This was a preview — nothing changed. To apply:  npx infinite-tag install --yes\n")
        return 0
      }
      case "apply": {
        if (!parsed.yes) {
          throw new Error("Founder approval is required. Re-run apply with --yes to continue.")
        }
        if (!parsed.workspaceId) {
          throw new Error("apply requires --workspace <workspace-id>.")
        }
        const plan = planInstallation({
          root,
          inspect,
          workspaceId: parsed.workspaceId,
          packageManager: parsed.packageManager,
          artifacts
        })
        if (parsed.json) {
          const result = applyInstallation({
            root,
            workspaceId: parsed.workspaceId,
            plan,
            allowDirty: parsed.allowDirty
          })
          printResult(parsed, result)
          return 0
        }
        const issue = renderPlanIssue(plan)
        if (issue) {
          console.log(issue)
          return 1
        }
        return applyAndRenderHuman({ root, inspect, plan, allowDirty: parsed.allowDirty })
      }
      case "verify": {
        const result = verifyInstallation({ root })
        if (parsed.json) {
          printResult(parsed, result)
        } else {
          console.log(renderVerify(result))
        }
        return result.buildOk ? 0 : 1
      }
      case "install": {
        const plan = planInstallation({
          root,
          inspect,
          workspaceId: parsed.workspaceId,
          packageManager: parsed.packageManager,
          artifacts
        })

        // Machine mode: preserve the exact legacy JSON contract.
        if (parsed.json) {
          if (!parsed.yes) {
            printResult(parsed, plan)
            console.error("Approval required before apply. Re-run with --yes to continue.")
            maybePrintCommands(parsed.command, inspect.packageManager as PackageManagerDetectionKind, parsed.workspaceId)
            return plan.blockers.length === 0 ? 0 : 1
          }
          if (!parsed.workspaceId) {
            throw new Error("install requires --workspace <workspace-id> when --yes is used.")
          }
          const applyResult = applyInstallation({
            root,
            workspaceId: parsed.workspaceId,
            plan,
            allowDirty: parsed.allowDirty
          })
          const verifyResult = verifyInstallation({ root })
          printResult(parsed, { inspect, plan, apply: applyResult, verify: verifyResult })
          return verifyResult.buildOk ? 0 : 1
        }

        // Human mode.
        const issue = renderPlanIssue(plan)
        if (issue) {
          console.log(issue)
          return plan.blockers.length === 0 ? 0 : 1
        }

        if (parsed.yes) {
          if (!parsed.workspaceId) {
            throw new Error("install requires --workspace <workspace-id> when --yes is used.")
          }
          return applyAndRenderHuman({ root, inspect, plan, allowDirty: parsed.allowDirty })
        }

        // Preview, then either confirm interactively (TTY) or print how to apply.
        console.log(renderPreview(plan))
        const canApplyNow = Boolean(parsed.workspaceId)
        if (process.stdin.isTTY && canApplyNow) {
          const approved = await confirmApply()
          if (!approved) {
            console.log("\nNo changes made. Run it later with:  npx infinite-tag install --yes\n")
            return 0
          }
          return applyAndRenderHuman({ root, inspect, plan, allowDirty: parsed.allowDirty })
        }

        const applyCommand = canApplyNow
          ? "npx infinite-tag install --yes"
          : "npx infinite-tag install --workspace <your-workspace-id> --yes"
        console.log(`This was a preview — nothing changed. To apply:  ${applyCommand}\n`)
        return 0
      }
      default:
        throw new Error(`Unknown command: ${parsed.command}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    return 1
  }
}

// Run as the CLI when invoked directly — robustly. npx and global installs invoke
// through a node_modules/.bin/<name> symlink, so process.argv[1] is the symlink
// path, NOT this module's real file path; the old `import.meta.url.endsWith(argv[1])`
// check failed there and the CLI silently no-op'd (exit 0, no output). Comparing
// resolved real paths makes npx, global-install, and direct `node cli.js` all work.
function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (!invoked) {
    return false
  }
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMainModule()) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode
  })
}
