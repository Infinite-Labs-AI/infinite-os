import { join } from "node:path"
import { loadPlanApprovals, loadPlanInputs, planCandidates } from "../install/step-inputs.js"
import { wizardGitExtras } from "../git/index.js"
import { isUnsupported } from "../hosts/other.js"
import { stageAndCommit, pushBranch } from "../review/ship.js"
import { commitStop, isShipContext, prepareShip } from "./steps/rehearsal.js"
import type { StepOutcome, WizardContext, WizardDeps } from "./contracts/deps.js"
import { refreshValidationBaseline } from "./local-validation.js"
import type { InstallManifest } from "../types.js"
import { siteSourceHosts } from "./steps/install.js"
import { resolveProductionHost } from "./site-host.js"
import { prepareCommitHistory } from "./commit-history.js"

const park = (reason: string): StepOutcome => ({ kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason, resumeHint: "Resolve the named files, then run `npx infinite-tag` to resume. The pull request stays draft." })

/** Runs once after reattaching the link, before any resumed worker or reviewer. */
export async function prepareResume(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome | null> {
  const state = ctx.state.get()
  if (state.pr?.mergeSha) return null
  if (state.pr?.number !== null && state.pr?.number !== undefined) {
    const pr = await deps.host.readPr(state.pr.number)
    if (!isUnsupported(pr) && pr.state !== "OPEN") return null
  }
  // Dependency installation must use this run's branch manifest too, not whichever branch was open.
  const branchGit = wizardGitExtras(deps.git)
  if (state.git && branchGit && await branchGit.currentBranch() !== state.git.branch) {
    try { await branchGit.switchTo(state.git.branch) }
    catch { return park(`Could not restore the recorded branch ${state.git.branch} before validating the site.`) }
  }
  if (state.git) await prepareCommitHistory(ctx, await deps.git.head())
  const baselineStop = await refreshValidationBaseline(ctx, deps)
  if (baselineStop) return baselineStop
  if (!state.pr || !deps.installer.refreshManaged) return null
  const saved = await loadPlanApprovals(ctx, deps)
  if (!saved || !state.plan || saved.planHash !== state.plan.hash) return park("The saved installation approvals are missing; the wizard cannot safely refresh its generated files.")
  const inputs = await loadPlanInputs(ctx, deps)
  if ("missingCapability" in inputs) return park(`The app cannot supply ${inputs.missingCapability} to refresh the installation.`)
  // before.json predates provisioning. Reconstruct the same approved source from this run's saved
  // host decision/claim and the committed public key, never an unrelated newer workspace key.
  let receipt: Partial<InstallManifest> | null = null
  try { receipt = JSON.parse(await deps.fs.readText(join(ctx.root, ".infinite/install.json")) ?? "null") as Partial<InstallManifest> | null }
  catch { return park("The install receipt cannot be read; the wizard left its generated files untouched.") }
  if (receipt?.providers?.includes("infinite") && receipt.ids?.infinite) {
    const claim = state.site?.claim
    const hosts = claim?.hosts ?? siteSourceHosts(inputs.keys, resolveProductionHost({ keys: inputs.keys, hosting: inputs.hosting, site: state.site ?? null }).host, inputs.before.observedProductionHost)
    const collectPath = claim?.collectPath ?? inputs.keys.infinite.collectPath
    if (hosts.length === 0 || !collectPath) return park("The saved run does not record the installed source's hosts and collection path; the wizard left its generated files untouched.")
    inputs.keys = { ...inputs.keys, infinite: { ...inputs.keys.infinite, status: "ready", siteSourceKey: receipt.ids.infinite.siteSourceKey, productionHosts: hosts, collectPath } }
  }
  const ship = await prepareShip(ctx, deps)
  if (!isShipContext(ship)) return ship
  const pendingPath = join(ctx.root, ".infinite/wizard/managed-refresh.json")
  const rawPending = await deps.fs.readText(pendingPath)
  let pending: { runId: string; sha: string } | null = null
  if (rawPending) {
    try {
      const parsed: unknown = JSON.parse(rawPending)
      if (parsed !== null) {
        if (typeof parsed !== "object" || !("runId" in parsed) || !("sha" in parsed) || typeof parsed.runId !== "string" || typeof parsed.sha !== "string" || !/^[a-f0-9]{40}$/.test(parsed.sha)) throw new Error("invalid refresh record")
        pending = { runId: parsed.runId, sha: parsed.sha }
      }
    } catch { return park("The saved managed-refresh.json record is unreadable. Restore or remove that damaged record before resuming.") }
  }
  if (pending) {
    const head = await ship.git.head()
    if (pending.runId !== ship.runId || !await ship.git.isAncestor(pending.sha, head)) return park(`The pending generated-file refresh is not an ancestor of this branch. Restore branch ${state.git!.branch} containing commit ${pending.sha}, then run \`npx infinite-tag\` again.`)
    // A user's merge/pull may advance HEAD while retaining the refresh commit. Continue from that
    // descendant instead of requiring equality with the pre-pull commit forever.
    if (pending.sha !== head) {
      // pushBranch checks every unrecorded commit against the run's SHA record and asks there.
      pending = { ...pending, sha: head }
      await deps.fs.writeTextAtomic(pendingPath, JSON.stringify(pending), 0o600)
    }
  }
  const scan = await deps.installer.scan({ root: ctx.root, appRoot: ctx.appRoot, hosting: inputs.hosting })
  const plan = deps.installer.buildPlan(scan, inputs.keys, inputs.before, await planCandidates(ctx, deps))
  // Reuse the approved decisions, even when the new scan labels an installed provider as an update.
  if (saved.plan) {
    plan.lines = saved.plan.lines
    plan.decisions = saved.plan.decisions
  }
  if (saved.guard) Object.assign(plan, { guard: saved.guard })
  let refreshed: { changedFiles: string[]; blocked: string[] }
  try {
    refreshed = await deps.installer.refreshManaged(plan, saved.approvals)
  } catch (error) {
    return park(ship.scanner.redact(`Could not refresh generated files: ${error instanceof Error ? error.message : String(error)}`).text)
  }
  if (refreshed.blocked.length > 0) return park(`Generated files changed since the committed install receipt: ${refreshed.blocked.join(", ")}. They were left untouched.`)
  if (refreshed.changedFiles.length > 0) {
    const commit = await stageAndCommit({ ctx, deps, git: ship.git, step: "review", scanner: ship.scanner, runId: ship.runId, message: "infinite-tag: refresh generated files on resume", round: null, allowlist: [], managed: refreshed.changedFiles, npmFiles: [], connectionIds: ship.facts.connectionIds })
    const stop = commitStop(commit)
    if (stop) return stop
    if (commit.kind !== "committed" || refreshed.changedFiles.some(file => !commit.staged.includes(file))) return park("The refreshed generated files could not all be committed. Review the held-back files before resuming.")
    pending = { runId: ship.runId, sha: await ship.git.head() }
    await deps.fs.writeTextAtomic(pendingPath, JSON.stringify(pending), 0o600)
  }
  if (!pending) return null
  const git = ctx.state.get().git!
  const pushed = await pushBranch({ ctx, deps, git: ship.git, scanner: ship.scanner, hostKind: deps.host.kind, base: git.base, branch: git.branch, title: "Infinite analytics" })
  if (pushed.kind !== "pushed") {
    const remote = state.pushTarget?.kind === "fork" ? state.pushTarget.remoteUrl : "origin"
    return park(`The refreshed generated files were committed but could not be pushed: ${pushed.message}. Run \`git pull --no-rebase ${remote} ${git.branch}\`, resolve any conflicts and commit the merge, then run \`npx infinite-tag\` again.`)
  }
  const head = await ship.git.head()
  await deps.fs.writeTextAtomic(pendingPath, "null\n", 0o600)
  ctx.state.update(draft => {
    draft.git!.headSha = head
    // The old rehearsal and review cannot describe the refreshed commit.
    delete draft.steps.rehearsal
    delete draft.steps.review
  })
  await ctx.state.save()
  ctx.emit.emit("step.sub", { step: "review", text: `Refreshed the wizard's generated files in commit ${head.slice(0, 7)} before resuming`, tone: "ok" })
  return null
}
