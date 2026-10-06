import { join } from "node:path"
import { buildPackageManager, frozenInstallCommand, type BuildRun } from "../checks/build.js"
import { sanitizeUntrusted } from "../agents/sanitize.js"
import type { WizardContext, WizardDeps, StepOutcome } from "./contracts/deps.js"
import type { BuildResult } from "./contracts/jobs.js"
import { readBeforeFactsFile, writeBeforeFactsFile } from "./handoff/before-facts.js"

export interface LocalValidation {
  baselineBuild: BuildResult
  localValidation: "measured" | "not_measured"
}

const stop = (message: string): StepOutcome => ({ kind: "failed", code: "INF_WIZ_VALIDATION_FAILED", message, next: "halt" })

export function unavailableValidationReason(build: BuildResult): string | null {
  if (build.ok) return null
  const run = build as Partial<BuildRun>
  if (run.error) return run.error
  if (run.timedOut) return "the check timed out"
  if (build.failureSignature.length === 0 || build.failureSignature.every((line) => /^(?:(?:build|lint): )?(?:exit_code:|timeout$|opaque:)/.test(line))) return "the check printed no comparable failure"
  return null
}

/** Resolve all knowable local-validation blockers before any worker job. */
export async function prepareLocalValidation(ctx: WizardContext, deps: WizardDeps): Promise<LocalValidation | StepOutcome> {
  const sub = (text: string, tone: "warn" | "pending") => ctx.emit.emit("step.sub", { step: "before", text, tone })
  let baselineBuild = await deps.checks.buildBaseline()
  const run = baselineBuild as Partial<BuildRun>
  const manager = run.packageManager ?? buildPackageManager(ctx.root, join(ctx.root, ctx.appRoot))
  if (run.skipped === "ambiguous_lockfiles" || manager === "ambiguous") return stop("Several lockfiles name different package managers. Keep the one your site uses, then run npx infinite-tag again.")
  const dependenciesPresent = await deps.fs.exists(join(ctx.root, "node_modules")) || await deps.fs.exists(join(ctx.root, ctx.appRoot, "node_modules")) || await deps.fs.exists(join(ctx.root, ".pnp.cjs"))
  const missing = !baselineBuild.ok && !dependenciesPresent && (run.exitCode === 127 || baselineBuild.failureSignature.some((line) => /exit_code:127$/.test(line)) || /executable.*not found/.test(run.error ?? ""))
  if (missing) {
    const command = frozenInstallCommand(manager)
    const installCommand = `${command.command} ${command.args.join(" ")}`
    const instruction = `Your site's dependencies are not installed here. Run \`${installCommand}\` in this repo, then resume.`
    if (ctx.options.yes || ctx.options.nested) return stop(instruction)
    if (await ctx.ask("confirm", { question: `Your site's dependencies are not installed here. Install them now with \`${installCommand}\`?`, defaultYes: true }) !== true) return stop(instruction)
    sub(`Installing your site's dependencies with ${installCommand}…`, "pending")
    const installed = await deps.checks.installDependencies?.((chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean).slice(-3)) sub(`Installing: ${sanitizeUntrusted(line, 160)}`, "pending")
    })
    if (!installed?.ok) return stop(`Could not install your site's dependencies (${installed?.reason ?? "the installer is unavailable"}). Run \`${installCommand}\` in this repo, then resume.`)
    baselineBuild = await deps.checks.buildBaseline()
    if ((baselineBuild as Partial<BuildRun>).exitCode === 127) return stop(`The site's executable is still unavailable after installation. Run \`${installCommand}\` and the site's build locally, then resume.`)
  }
  const why = unavailableValidationReason(baselineBuild)
  if (why !== null) {
    sub(`The wizard cannot run your build and lint here (${sanitizeUntrusted(why, 160)}); your pull request's own checks will be the judge`, "warn")
    return { baselineBuild, localValidation: "not_measured" }
  }
  if (!baselineBuild.ok) sub("Your site's build or lint ran and already fails on the base; the wizard will only fix new failures", "warn")
  return { baselineBuild, localValidation: "measured" }
}

/** Legacy signatures were not file-scoped. Retake them on the base before resuming work. */
export async function refreshValidationBaseline(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome | null> {
  const before = await readBeforeFactsFile(deps.fs, ctx.root, ctx.runId)
  if (!before) return null
  const baseline = before.facts.baselineBuild as Partial<BuildRun> | null
  if (baseline?.signatureVersion === 2 && baseline.failureSignature?.every((line) => /^(?:build|lint): /.test(line))) return null
  const next = await prepareLocalValidation(ctx, deps)
  if ("kind" in next) return next
  await writeBeforeFactsFile(deps.fs, ctx.root, { ...before, facts: { ...before.facts, ...next } })
  return null
}
