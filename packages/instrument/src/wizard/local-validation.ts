import { join, relative } from "node:path"
import { buildPackageManager, dependencyInstallPlan, type BuildRun } from "../checks/build.js"
import { sanitizeUntrusted } from "../agents/sanitize.js"
import type { WizardContext, WizardDeps, StepOutcome } from "./contracts/deps.js"
import type { BuildResult } from "./contracts/jobs.js"
import { readBeforeFactsFile, writeBeforeFactsFile } from "./handoff/before-facts.js"

export interface LocalValidation {
  baselineBuild: BuildResult
  localValidation: "measured" | "not_measured"
}

const stop = (message: string): StepOutcome => ({ kind: "failed", code: "INF_WIZ_VALIDATION_FAILED", message, next: "halt" })
export const DEPENDENCY_INSTALL_RECORD = ".infinite/wizard/dependencies.json"
interface InstallAttempt { state: "in_progress" | "failed" | "succeeded"; createdLockfiles: string[] }

async function installAttempt(ctx: WizardContext, deps: WizardDeps): Promise<InstallAttempt | null> {
  try {
    const data = JSON.parse(await deps.fs.readText(join(ctx.root, DEPENDENCY_INSTALL_RECORD)) ?? "null") as InstallAttempt | null
    return data && ["in_progress", "failed", "succeeded"].includes(data.state) && Array.isArray(data.createdLockfiles) ? data : null
  } catch { return { state: "failed", createdLockfiles: [] } }
}

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
  const attempt = await installAttempt(ctx, deps)
  const retry = attempt !== null && attempt.state !== "succeeded"
  let baselineBuild: BuildResult = retry ? { ok: false, durationMs: 0, failureSignature: ["exit_code:127"] } : await deps.checks.buildBaseline()
  const run = baselineBuild as Partial<BuildRun>
  const manager = run.packageManager ?? buildPackageManager(ctx.root, join(ctx.root, ctx.appRoot))
  if (run.skipped === "ambiguous_lockfiles" || manager === "ambiguous") return stop("Several lockfiles name different package managers. Keep the one your site uses, then run npx infinite-tag again.")
  const dependenciesPresent = await deps.fs.exists(join(ctx.root, "node_modules")) || await deps.fs.exists(join(ctx.root, ctx.appRoot, "node_modules")) || await deps.fs.exists(join(ctx.root, ".pnp.cjs"))
  const missing = !baselineBuild.ok && !dependenciesPresent && (run.exitCode === 127 || baselineBuild.failureSignature.some((line) => /exit_code:127$/.test(line)) || /executable.*not found/.test(run.error ?? ""))
  if (missing || retry) {
    const command = await dependencyInstallPlan(ctx.root, ctx.appRoot, manager, path => deps.fs.exists(path), path => deps.fs.readText(path))
    const installCommand = `${command.command} ${command.args.join(" ")}`
    const instruction = `Your site's dependencies are not installed here. Run \`${installCommand}\` in this repo, then resume.`
    const lockNote = command.createsLockfile ? " There is no lockfile; this will create one, left untracked and never committed by the wizard." : ""
    if (ctx.options.yes || ctx.options.nested) return stop(`${instruction}${lockNote}`)
    const question = retry ? `The previous dependency install did not finish. Retry with \`${installCommand}\`?` : `Your site's dependencies are not installed here. Install them now with \`${installCommand}\`?`
    if (await ctx.ask("confirm", { question: `${question}${lockNote}`, defaultYes: true }) !== true) return stop(`${instruction}${lockNote}`)
    const createdLockfiles = [...new Set([...(attempt?.createdLockfiles ?? []), ...(command.createsLockfile ? [relative(ctx.root, command.lockfile)] : [])])]
    const save = (state: InstallAttempt["state"]) => deps.fs.writeTextAtomic(join(ctx.root, DEPENDENCY_INSTALL_RECORD), `${JSON.stringify({ state, createdLockfiles })}\n`, 0o600)
    await deps.fs.mkdirp(join(ctx.root, ".infinite/wizard"), 0o700)
    await save("in_progress")
    sub(`Installing your site's dependencies with ${installCommand}…`, "pending")
    const installed = await deps.checks.installDependencies?.((chunk) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean).slice(-3)) sub(`Installing: ${sanitizeUntrusted(line, 160)}`, "pending")
    })
    await save(installed?.ok ? "succeeded" : "failed")
    if (!installed?.ok) return stop(`Could not install your site's dependencies (${installed?.reason ?? "the installer is unavailable"}). Run \`${installCommand}\` in this repo, then resume.`)
    baselineBuild = await deps.checks.buildBaseline()
    if ((baselineBuild as Partial<BuildRun>).exitCode === 127) return stop(`The site's executable is still unavailable after installation. Run \`${installCommand}\` and the site's build locally, then resume.`)
  }
  if ((baselineBuild as Partial<BuildRun>).exitCode === 127) return stop("The site's build executable is unavailable despite an installed dependency folder. Fix the site's install or build script, then resume.")
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
  const attempt = await installAttempt(ctx, deps)
  if ((!attempt || attempt.state === "succeeded") && baseline?.signatureVersion === 3 && baseline.failureSignature?.every((line) => /^(?:build|lint): /.test(line))) return null
  const next = await prepareLocalValidation(ctx, deps)
  if ("kind" in next) return next
  await writeBeforeFactsFile(deps.fs, ctx.root, { ...before, facts: { ...before.facts, ...next } })
  return null
}
