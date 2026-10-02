// Step `install` (§3d.1 step 5, lane O7): "Install".
//
// Ensures the site source and records the consent answer through the site-source verb (C4 records it
// behind the wizard's own gate), then installs: the managed tags for the approved new tools, the
// approved improve-in-place code edits, the preview guard, the npm line, a build check with a full
// rollback, and the edit receipt. A pending manual edit (`requiresManual`) becomes an OPEN JOB 2,
// never "installed". With no consent answer the run never gets here: it parks at `plan`.
import { createHash } from "node:crypto"

import type { WizardApplyResult } from "../../install/installer.js"
import { DECISION_LINE_IDS } from "../../install/plan-model.js"
import { bridgeErrorCode, keysOnly, loadPlanApprovals, loadPlanInputs, planCandidates } from "../../install/step-inputs.js"
import { bridgeFailureLine, bridgeFailureOutcome, bridgeFailureState } from "../../bridge/outcomes.js"
import { productionHostHint } from "./link.js"
import type { InstallerApplyResult } from "../contracts/jobs.js"
import { JOB_TABLE, type ChecklistItem } from "../contracts/jobs.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import type { TagHosting, TagKeys } from "../contracts/bridge.js"
import { HOST_DENY_V1, normalizeHost } from "../contracts/host-deny.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"

const meta = WIZARD_STEP_META.install

const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`

const PARK_HINT = "Run `npx infinite-tag --resume` to confirm the plan again."

/** §3a.6: at most 10 production hosts per site-source call. */
const MAX_SITE_SOURCE_HOSTS = 10

function sub(ctx: WizardContext, text: string, tone: "ok" | "warn" | "info" | "pending"): void {
  ctx.emit.emit("step.sub", { step: "install", text, tone })
}

function denied(host: string): boolean {
  const normalized = normalizeHost(host)
  return HOST_DENY_V1.deny.exact.includes(normalized) || HOST_DENY_V1.deny.suffix.some((suffix) => normalized.endsWith(suffix))
}

/**
 * §3z.7 (A28): the site source's `productionHosts` = the normalised union of keys `infinite.productionHosts`,
 * the link's `productionHostHint` (when set) and `before`'s observed final production host (when it is not
 * deny-shaped); at most 10, no duplicates, and no preview-shaped host (`*.vercel.app`, …) unless Infinite
 * already lists it. The cloud treats `www.<host>` and `<host>` as one site and proves a host it has not
 * verified through the linked Vercel project.
 */
export function siteSourceHosts(keys: TagKeys, hint: string | null, observed: string | null): string[] {
  const listed = keys.infinite.productionHosts.map(normalizeHost).filter((host) => host !== "")
  const extra = [...(hint ? [hint] : []), ...(observed ? [observed] : [])].map(normalizeHost).filter((host) => host !== "" && !denied(host))
  return [...new Set([...listed, ...extra])].slice(0, MAX_SITE_SOURCE_HOSTS)
}

/** Job 2 ("unusual layout") for each file the installer could not edit itself: an open job, never installed. */
export function openLayoutJobs(paths: readonly string[], existing: readonly ChecklistItem[]): ChecklistItem[] {
  const spec = JOB_TABLE.unusual_layout
  return paths
    .map((path): ChecklistItem => ({
      id: `unusual_layout:${path}`,
      jobId: "unusual_layout",
      n: spec.n,
      title: spec.title,
      owner: "agent",
      trigger: { finding: `The installer could not add the managed tag to ${path}; it must be added in the real page shell.`, evidence: [{ file: path, line: 1 }] },
      allow: { files: [path], create: [] },
      checks: spec.checks.map((check) => ({ id: check.checkId, tier: check.tier, state: "not_run" as const })),
      state: "pending"
    }))
    .filter((item) => !existing.some((other) => other.id === item.id))
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const state = ctx.state.get()
  if (!state.plan || state.plan.answers.consentMode === null) {
    return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "The plan's consent mode is unanswered.", resumeHint: PARK_HINT }
  }
  const consentMode = state.plan.answers.consentMode
  const savedApprovals = await loadPlanApprovals(ctx, deps)
  if (!savedApprovals || savedApprovals.planHash !== state.plan.hash) {
    return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "The saved plan answers are missing.", resumeHint: PARK_HINT }
  }

  const inputs = await loadPlanInputs(ctx, deps)
  if ("missingCapability" in inputs) {
    return { kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL", message: `The Infinite app does not offer ${inputs.missingCapability}; update the app.`, next: "halt" }
  }
  const scan = await deps.installer.scan({ root: ctx.root, ...(ctx.appRoot !== "." ? { appRoot: ctx.appRoot } : {}), hosting: inputs.hosting })
  const candidates = await planCandidates(ctx, deps)
  let keys = keysOnly(inputs.keys)

  // The plan the user approved must still be the plan: the same lines (the approvals name them).
  const check = deps.installer.buildPlan(scan, keys, inputs.before, candidates)
  const approvedIds = new Set(state.plan.lines.map((line) => line.id))
  if (check.lines.length !== approvedIds.size || check.lines.some((line) => !approvedIds.has(line.id))) {
    // Forget the old plan so the resume re-runs `plan` and asks again: the engine skips a step whose
    // record is ok with unchanged inputs, which would park here on every resume (P2-15).
    ctx.state.update((current) => {
      delete current.steps.plan
      current.plan = null
    })
    await ctx.state.save()
    return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "The saved plan changed; re-confirm it.", resumeHint: PARK_HINT }
  }
  const approved = new Set(state.plan.lines.filter((line) => line.approved === true).map((line) => line.id))

  // Engine invariant (§3a.9.4): no state-changing verb while an agent child is alive.
  if (deps.agents.isAgentAlive()) throw new Error("An agent is still running; the site source is not changed while one runs.")

  // ---- the site source + the consent answer: ONLY behind an approved Infinite line (P2-20) ----
  const installInfinite = check.lines.some((line) => line.kind === "install_provider" && line.id.startsWith("install_provider:infinite") && approved.has(line.id))
  if (installInfinite) {
    const hosts = siteSourceHosts(keys, await productionHostHint(ctx, deps), inputs.before.observedProductionHost)
    if (hosts.length === 0) {
      sub(ctx, "Infinite does not know your production domain yet: Infinite's tag is not installed this run", "warn")
    } else {
      try {
        const source = await deps.bridge.ensureSiteSource({ productionHosts: hosts, consentMode }, { signal: ctx.signal })
        keys = {
          ...keys,
          infinite: { ...keys.infinite, status: "ready", siteSourceKey: source.siteSourceKey, productionHosts: source.productionHosts, consentMode: source.consentMode }
        }
        sub(ctx, `✓ Site source ${source.created ? "created" : "updated"} · consent ${source.consentMode === "required" ? "waits for your banner" : "collects by default"}`, "ok")
      } catch (error) {
        const code = bridgeErrorCode(error)
        const state = bridgeFailureState(error)
        if (code === "foreign_site_hosts" || (code === "invalid_request" && state === "unverified_host")) {
          // §3z.7 (A28): another site's source, or a host the workspace has not proven: no Infinite pixel is
          // installed (its key is never written into this site), one user line, and the other tools go on.
          keys = { ...keys, infinite: { ...keys.infinite, status: "not_provisioned", siteSourceKey: null } }
          const line =
            code === "invalid_request"
              ? `Prove ${hosts[0] ?? "your domain"} in Infinite (Site Settings), then run npx infinite-tag again; Infinite's tag is not installed this run`
              : (bridgeFailureLine(error, "Infinite's tag") ?? "This workspace collects for another site; Infinite's tag is not installed here")
          sub(ctx, line, "warn")
        } else {
          // §3z.4: 402 / signed out / a lock (423 → parked SITE_LOCKED) / Infinite unavailable / …
          const outcome = bridgeFailureOutcome(error, { verb: "site-source" })
          if (outcome) return outcome
          throw error
        }
      }
    }
  }

  // ---- the install itself (rebuilt with the site source; same line ids, so the approvals still name them) ----
  const plan = deps.installer.buildPlan(scan, keys, inputs.before, candidates)
  const writesProxy = plan.lines.some((line) => approved.has(line.id) && (line.id.startsWith("install_provider:posthog") || line.id === "improve_additive:posthog:proxy"))
  sub(ctx, writesProxy ? "Writing tags and the /ingest proxy…" : "Writing tags…", "pending")
  if (approved.has(DECISION_LINE_IDS.npmInstall)) sub(ctx, "Installing the server-lane package…", "pending")
  const result = (await deps.installer.apply(plan, savedApprovals.approvals)) as InstallerApplyResult & Partial<WizardApplyResult>

  if (!result.ok) {
    return {
      kind: "failed",
      code: "INF_WIZ_APPLY_ROLLED_BACK",
      message: `${result.reason ?? "The install failed."}${result.rolledBack ? " Nothing was left half-installed." : " Review `git diff`: the rollback did not complete."}`,
      next: "halt"
    }
  }
  for (const warning of result.warnings ?? []) sub(ctx, warning.length > 120 ? `${warning.slice(0, 117)}…` : warning, "warn")

  // ---- open jobs: a manual edit is job 2, never "installed"; it passes the ONE seeding gate (B13) ----
  const openJobs = deps.registry.applyApprovals(openLayoutJobs(result.openJobs, ctx.state.get().jobs), plan, savedApprovals.approvals)
  if (openJobs.length > 0 || result.edits.length > 0) {
    ctx.state.update((current) => {
      current.jobs = [...current.jobs, ...openJobs]
    })
    await ctx.state.save()
  }
  if (result.build === "passed") sub(ctx, "✓ Build passes", "ok")
  else if (result.build === "failed_baseline") sub(ctx, "The build was already failing before this run (not caused by the install)", "warn")

  const files = result.changedFiles?.length ?? result.edits.length
  const build = result.build === "passed" ? "build passes" : result.build === "failed_baseline" ? "build was already red" : "build not checked yet"
  const open = result.openJobs.length > 0 ? ` · ${result.openJobs.length} file${result.openJobs.length === 1 ? "" : "s"} need${result.openJobs.length === 1 ? "s" : ""} the agent (not live yet)` : ""
  return { kind: "ok", status: `${files} file${files === 1 ? "" : "s"} written · ${build}${open}` }
}

export const step: WizardStep<"install"> = {
  id: "install",
  title: meta.title,
  who: [...meta.who],
  learn: meta.learn,
  requiredCapabilities: [...meta.requiredCapabilities],
  /** The approved plan (its hash and the per-line answers) is this step's input. */
  inputHash(ctx) {
    const plan = ctx.state?.get().plan
    return sha256(JSON.stringify({ step: "install", plan: plan ? { hash: plan.hash, lines: plan.lines, consent: plan.answers.consentMode } : null }))
  },
  run
}
