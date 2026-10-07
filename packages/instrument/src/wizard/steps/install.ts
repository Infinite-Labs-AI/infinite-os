import { configRewriteJobs } from "../../install/config-rewrite-jobs.js"
// Step `install` (§3d.1 step 5, lane O7): "Install".
//
// Ensures the site source and records the consent answer through the site-source verb (C4 records it
// behind the wizard's own gate), then installs: the managed tags for the approved new tools, the
// approved improve-in-place code edits, the preview guard, the npm line, a build check with a full
// rollback, and the edit receipt. A pending manual edit (`requiresManual`) becomes an OPEN JOB 2,
// never "installed". With no consent answer the run never gets here: it parks at `plan`.
import { createHash } from "node:crypto"

import type { WizardApplyResult } from "../../install/installer.js"
import type { ManualRequirement } from "../../types.js"
import { itemT0Scenarios, runItemT0, t0RunParams } from "../item-t0.js"
import type { CheckResult } from "../contracts/jobs.js"
import { DECISION_LINE_IDS } from "../../install/plan-model.js"
import { CAPTURE_WAITING } from "../../install/consent-handoff.js"
import { bridgeErrorCode, keysOnly, loadPlanApprovals, loadPlanInputs, planCandidates } from "../../install/step-inputs.js"
import { bridgeFailureLine, bridgeFailureOutcome, bridgeFailureState, hardStopOutcome } from "../../bridge/outcomes.js"
import { makeEditRecord } from "../../install/edits.js"
import { isProofBody, PROOF_FILE_PLAN_LINE_ID, proofFileTarget } from "../../install/proof-file.js"
import { isPreviewShapedHost, resolveProductionHost } from "../site-host.js"
import { GITIGNORE_FENCE_START } from "../../harness/outputs.js"
import { wizardGitExtras } from "../../git/index.js"
import type { InstallerApplyResult } from "../contracts/jobs.js"
import { JOB_TABLE, type ChecklistItem } from "../contracts/jobs.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import type { ClaimPublic, SiteSourceFields, TagHosting, TagKeys } from "../contracts/bridge.js"
import { normalizeHost } from "../contracts/host-deny.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"

const meta = WIZARD_STEP_META.install

const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`

const PARK_HINT = "Run `npx infinite-tag --resume` to confirm the plan again."

/** §3a.6: at most 10 production hosts per site-source call. */
const MAX_SITE_SOURCE_HOSTS = 10

function sub(ctx: WizardContext, text: string, tone: "ok" | "warn" | "info" | "pending"): void {
  ctx.emit.emit("step.sub", { step: "install", text, tone })
}

/**
 * §3z.7 (A28): the site source's `productionHosts` = the normalised union of keys `infinite.productionHosts`,
 * the link's `productionHostHint` (when set) and `before`'s observed final production host (when it is not
 * deny-shaped); at most 10, no duplicates, and no platform host (`*.vercel.app`, `vercel.app`, `github.io`, …)
 * unless Infinite already lists it. The cloud treats `www.<host>` and `<host>` as one site and proves a host it has not
 * verified through the linked Vercel project.
 */
export function siteSourceHosts(keys: TagKeys, hint: string | null, observed: string | null): string[] {
  const listed = keys.infinite.productionHosts.map(normalizeHost).filter((host) => host !== "")
  // Founder ruling 2026-10-03: only the site's own domain. A platform address (ANY `*.vercel.app`, a production alias
  // included, or a bare `vercel.app` / `github.io`) never joins, as the hint or as the observed host.
  const extra = [...(hint ? [hint] : []), ...(observed ? [observed] : [])].map(normalizeHost).filter((host) => host !== "" && !isPreviewShapedHost(host))
  return [...new Set([...listed, ...extra])].slice(0, MAX_SITE_SOURCE_HOSTS)
}

/** The `.gitignore` plan line id of the wizard's own fence (B24). */
export const GITIGNORE_FENCE_LINE_ID = "gitignore_fence"

/**
 * B24: the wizard's `.gitignore` fence (written after `before`) is an edit like any other, so it is recorded
 * in `.infinite/install.json` with `by: "wizard"` and the uninstall can reverse it. Compares the committed
 * `.gitignore` (null = the fence created the file) with the working copy; nothing is recorded when they
 * match (a resumed run whose fence is already committed) or when no fence is present.
 */
export async function recordGitignoreFence(ctx: WizardContext, deps: WizardDeps): Promise<boolean> {
  const after = await deps.fs.readText(`${ctx.root}/.gitignore`)
  if (after === null || !after.includes(GITIGNORE_FENCE_START)) return false
  // `in` (not a property read): a contract-only fake carries no extras and must not be asked for them.
  const git = "showFile" in deps.git ? wizardGitExtras(deps.git) : null
  if (!git) return false
  const before = await git.showFile("HEAD", ".gitignore")
  if (before === after) return false
  const runId = ctx.state.get().runId
  if (runId === null) return false
  await deps.installer.recordEdits([makeEditRecord({ file: ".gitignore", before, after, jobId: null, planLineId: GITIGNORE_FENCE_LINE_ID, by: "wizard", runId })])
  return true
}

/**
 * §3y.2: writes `.well-known/infinite-site-verification.txt` (the cloud's exact public body) where the framework
 * serves it, and records it in `.infinite/install.json` (`by:"wizard"`, `planLineId:"install_provider:infinite"`,
 * `jobId:null`). An identical file already there (a resume) records nothing new.
 */
export async function writeProofFile(
  ctx: WizardContext,
  deps: WizardDeps,
  scan: { appRoot: string; framework: string },
  claim: Pick<ClaimPublic, "proofBody"> & Partial<Pick<ClaimPublic, "state">>
): Promise<string | null> {
  const target = proofFileTarget(ctx.root, scan.appRoot, scan.framework)
  if (!("path" in target) || !isProofBody(claim.proofBody)) return null
  const absolute = `${ctx.root}/${target.path}`
  const before = await deps.fs.readText(absolute)
  if (before === claim.proofBody) return target.path
  await deps.fs.mkdirp(absolute.slice(0, absolute.lastIndexOf("/")), 0o755)
  await deps.fs.writeTextAtomic(absolute, claim.proofBody, 0o644)
  const runId = ctx.state.get().runId
  if (runId !== null) {
    await deps.installer.recordEdits([makeEditRecord({ file: target.path, before, after: claim.proofBody, jobId: null, planLineId: PROOF_FILE_PLAN_LINE_ID, by: "wizard", runId })])
  }
  sub(
    ctx,
    claim.state === "proven"
      ? `✓ Wrote ${target.path} (your domain is confirmed; previews serve it so the Infinite app can test them)`
      : `✓ Wrote ${target.path} (Infinite reads it after your merge to confirm the domain)`,
    "ok"
  )
  return target.path
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

/** Known installer proposals held at the owner boundary are information, never worker tasks. */
export function ownerLayoutJobs(requirements: readonly ManualRequirement[], existing: readonly ChecklistItem[] = []): ChecklistItem[] {
  const byPlacement = new Map<string, ManualRequirement[]>()
  for (const requirement of requirements) {
    if (!requirement.ownerBoundary) continue
    // A file may need more than one handoff with different placement/frozen-unit provenance.
    const key = JSON.stringify([requirement.path, requirement.ownerBoundary])
    byPlacement.set(key, [...byPlacement.get(key) ?? [], requirement])
  }
  const occupied = existing.filter(job => job.state === "left_for_you" && job.ownerBoundary)
  return [...byPlacement.values()].map(entries => {
    const path = entries[0]!.path
    const first = entries[0]!
    const wiring = [...new Set(entries.map(entry => entry.snippet).filter(Boolean))].join("\n\n")
    const note = [...new Set(entries.map(entry => entry.reason))].join("\n")
    const ownerBoundary = { ...first.ownerBoundary!, ...(wiring ? { wiring } : {}) }
    const identity = JSON.stringify([ownerBoundary, note])
    const baseId = `unusual_layout:${path}`
    const matching = occupied.find(job => (job.id === baseId || job.id.startsWith(`${baseId}:handoff:`)) && JSON.stringify([job.ownerBoundary, job.note]) === identity)
    let id = matching?.id ?? baseId
    if (!matching && occupied.some(job => job.id === id)) id = `${baseId}:handoff:${sha256(identity).slice(7)}`
    const job: ChecklistItem = { id, jobId: "unusual_layout", n: JOB_TABLE.unusual_layout.n,
      title: `Analytics wiring left for you: ${path}`, owner: "code", state: "left_for_you", checks: [], allow: { files: [], create: [] }, note,
      ownerBoundary,
      trigger: { finding: `${note}${wiring ? `\n\nFor you to copy into ${path}; preserve your consent code. The wizard did not add this wiring.\n\n\`\`\`js\n${wiring}\n\`\`\`` : ""}`, evidence: [{ file: path, line: first.ownerBoundary!.line }] } }
    occupied.push(job)
    return job
  })
}

export { CONFIG_REWRITES_TARGET, configRewriteJobs } from "../../install/config-rewrite-jobs.js"

/** Validate the deterministic capture using its actual static and offline evidence; never dispatch a worker. */
export async function verifyManagedCaptureJobs(ctx: WizardContext, deps: Pick<WizardDeps, "checks" | "registry" | "fs">, result: InstallerApplyResult & Partial<WizardApplyResult>, params: Readonly<Record<string, unknown>>): Promise<void> {
  if (result.managedCapture) {
    const runId = ctx.state.get().runId ?? ctx.runId
    if (runId) {
      for (const saved of ctx.state.get().jobs.filter(job => job.owner === "code" && job.jobId === "meta_improve" && /^meta_improve:capture(?::|$)/.test(job.id) && job.state !== "left_for_you")) {
        const item: ChecklistItem = { ...saved, state: "claimed", consentActivation: result.managedCapture.mode === "required" ? "waiting_banner_signal" : undefined, claim: { status: "done", note: "The wizard emitted the managed module and its fixed entrypoint wiring", at: ctx.now().toISOString() }, edits: [...saved.edits ?? [], ...result.edits.filter(edit => edit.jobId === "meta_improve:capture").map(edit => ({ editId: edit.id, file: edit.file }))] }
        const raw = await deps.checks.run("click_id_capture", { item, root: ctx.root, appRoot: ctx.appRoot, runId })
        const staticChecks: CheckResult[] = (Array.isArray(raw) ? raw : [raw]).map(check => ({ ...check, tier: "S", runId }))
        const scenarios = await itemT0Scenarios(item, [{ checkId: "fbc_capture" }], params, { root: ctx.root, fs: deps.fs })
        const offline = await runItemT0(deps, scenarios, result.artifacts ?? {}, { runId, at: () => ctx.now().toISOString() })
        const [checked] = deps.registry.apply([item], [...staticChecks, ...offline.map(check => ({ ...check, tier: "T0" as const, runId }))], runId)
        if (checked) {
          if (checked.consentActivation && ["done_in_code", "waiting_deploy", "proven"].includes(checked.state)) { checked.state = "done_in_code"; checked.note = CAPTURE_WAITING }
          ctx.state.update(current => { current.jobs = current.jobs.map(job => job.id === checked.id ? checked : job) })
          ctx.emit.emit("job.state", { itemId: checked.id, state: checked.state, by: "wizard", note: checked.note ?? "Managed capture checked from the emitted module and fixed entrypoint" })
        }
      }
      await ctx.state.save()
    }
  }
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const state = ctx.state.get()
  // R2-6: the consent answer is required only when the plan asked it (it is left out when nothing it governs exists).
  const asksConsent = state.plan?.lines.some((line) => line.id === DECISION_LINE_IDS.consentMode) ?? false
  if (!state.plan || (state.plan.answers.consentMode === null && asksConsent)) {
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

  // Review I1 P1-2: an install that cannot be applied stops HERE, before the first cloud write (the site source).
  const blocked = deps.installer.preflight?.(check, savedApprovals.approvals) ?? null
  if (blocked) {
    return {
      kind: "failed",
      code: "INF_WIZ_APPLY_ROLLED_BACK",
      message: `The install cannot be applied as planned: ${blocked} Nothing was written, in the repo or in Infinite.`,
      next: "halt"
    }
  }

  // Engine invariant (§3a.9.4): no state-changing verb while an agent child is alive.
  if (deps.agents.isAgentAlive()) throw new Error("An agent is still running; the site source is not changed while one runs.")

  // ---- the site source + the consent answer: ONLY behind an approved Infinite line (P2-20) ----
  const installInfinite = check.lines.some((line) => line.kind === "install_provider" && line.id.startsWith("install_provider:infinite") && approved.has(line.id))
  let claim: ClaimPublic | null = null
  // Review P1-5: the claim whose proof line this install keeps in the repo. A pending claim's (the proof the merge
  // must serve), and on the verified-source path the workspace's PROVEN claim's: every PR preview and merge deployment
  // then serves the same line, which is how the app ties a preview address to this site without a Vercel connection.
  let proofClaim: ClaimPublic | null = null
  // An Infinite install always comes with the consent line (the plan asks it whenever Infinite can be installed).
  if (installInfinite && consentMode === null) {
    return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "The plan's consent mode is unanswered.", resumeHint: PARK_HINT }
  }
  if (installInfinite && consentMode !== null) {
    // §3y.1: the one production host (Infinite's, this run's answer, or the flag); repo hints never answer it.
    const host = resolveProductionHost({ keys, hosting: inputs.hosting, site: ctx.state.get().site ?? null }).host
    const hosts = siteSourceHosts(keys, host, inputs.before.observedProductionHost)
    if (hosts.length === 0) {
      sub(ctx, "Infinite does not know your production domain yet: Infinite's tag is not installed this run", "warn")
    } else {
      // §3y.2: the claim verb in place of site-source whenever the app offers it (the cloud answers the source when
      // the hosts are verified, else a pending claim with a reserved key: nothing is collected before the proof).
      const useClaim = deps.bridge.has("tag.site-claim.v1")
      const runId = ctx.state.get().runId
      try {
        let source: SiteSourceFields | null = null
        if (useClaim && runId) {
          const answer = await deps.bridge.siteClaim({ runId, productionHosts: hosts, consentMode }, { signal: ctx.signal })
          source = answer.state === "ready" ? answer.siteSource : null
          claim = answer.state === "pending_proof" ? answer.claim : null
          if (!source && !claim) throw new Error("site-claim answered neither a site source nor a claim")
          if (source) {
            // The verified path: the workspace's proven claim on these hosts, if it has one (a source verified through
            // a Vercel connection has none, and the app accepts its previews through that connection instead).
            const held = (await deps.bridge.readSiteClaim({ signal: ctx.signal })).claim
            if (held && held.state === "proven" && isProofBody(held.proofBody) && hosts.some((entry) => held.hosts.includes(entry))) proofClaim = held
          }
        } else {
          const answer = await deps.bridge.ensureSiteSource({ productionHosts: hosts, consentMode }, { signal: ctx.signal })
          source = { siteSourceKey: answer.siteSourceKey, productionHosts: answer.productionHosts, consentMode: answer.consentMode, created: answer.created }
        }
        if (source) {
          keys = {
            ...keys,
            infinite: { ...keys.infinite, status: "ready", siteSourceKey: source.siteSourceKey, productionHosts: source.productionHosts, consentMode: source.consentMode }
          }
          sub(ctx, `✓ Site source ${source.created ? "created" : "updated"} · consent ${source.consentMode === "required" ? "waits for your banner" : "collects by default"}`, "ok")
        } else if (claim) {
          const placed = proofFileTarget(ctx.root, scan.appRoot, scan.framework)
          if (!("path" in placed) || !isProofBody(claim.proofBody)) {
            // The proof file cannot be served (or the cloud's body is not the exact public form): no tag goes in
            // with a key nothing could ever prove.
            claim = null
            keys = { ...keys, infinite: { ...keys.infinite, status: "not_provisioned", siteSourceKey: null } }
            sub(ctx, "Infinite: the proof file cannot be placed where this site serves it; Infinite's tag is not installed this run", "warn")
          } else {
            // The managed tag carries the RESERVED key (in memory only); ingest refuses it until the proof.
            keys = {
              ...keys,
              infinite: {
                status: "ready",
                siteSourceKey: claim.siteSourceKey,
                productionHosts: [...claim.hosts],
                consentMode: claim.consentMode,
                consentStorageKey: claim.consentStorageKey,
                collectPath: claim.collectPath
              }
            }
            const pending = claim
            proofClaim = claim
            ctx.state.update((current) => {
              current.site = {
                ...(current.site ?? { productionHost: host, source: "answer" as const, decidedAt: ctx.now().toISOString() }),
                claim: {
                  hosts: [...pending.hosts],
                  siteSourceKey: pending.siteSourceKey,
                  collectPath: pending.collectPath,
                  consentStorageKey: pending.consentStorageKey,
                  proofPath: pending.proofPath,
                  state: "pending_proof"
                }
              }
            })
            await ctx.state.save()
            sub(ctx, `Infinite reserved a site key for ${pending.hosts[0]}: it records nothing until your merge serves the proof file`, "info")
          }
        }
      } catch (error) {
        const code = bridgeErrorCode(error)
        const state = bridgeFailureState(error)
        // A hard stop first (review I2 P2-2: Infinite's own workspace is a 409 `foreign_site_hosts` too, and halts).
        const hard = hardStopOutcome(error)
        if (hard) return hard
        if (code === "foreign_site_hosts" || (code === "invalid_request" && state === "unverified_host")) {
          // §3z.7 (A28): another site's source, or a host the workspace has not proven: no Infinite pixel is
          // installed (its key is never written into this site), one user line, and the other tools go on.
          keys = { ...keys, infinite: { ...keys.infinite, status: "not_provisioned", siteSourceKey: null } }
          claim = null
          proofClaim = null
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
  await recordGitignoreFence(ctx, deps)
  // §3y.2: the claim's ONE managed file, recorded as the wizard's own edit (the PR carries it; uninstall removes it).
  if (proofClaim) await writeProofFile(ctx, deps, scan, proofClaim)

  // ---- open jobs: a manual edit is job 2, never "installed"; it passes the ONE seeding gate (B13) ----
  const openJobs = deps.registry.applyApprovals(
    [...openLayoutJobs(result.openJobs, ctx.state.get().jobs), ...configRewriteJobs(result.deferredConfigRewrites ?? [], ctx.state.get().jobs)],
    plan,
    savedApprovals.approvals
  )
  const ownerJobs = ownerLayoutJobs(result.ownerRequirements ?? [], ctx.state.get().jobs)
  for (const job of ownerJobs) sub(ctx, job.trigger.finding, "info")
  for (const deferred of result.deferredConfigRewrites ?? []) {
    sub(ctx, `Your own ${deferred.path} is left as it is: the agent adds Infinite's collect rewrite there (the wizard checks it)`, "info")
  }
  if (openJobs.length > 0 || ownerJobs.length > 0 || result.edits.length > 0) {
    ctx.state.update((current) => {
      const ownerIds = new Set(ownerJobs.map(job => job.id))
      current.jobs = [...current.jobs.filter(job => !ownerIds.has(job.id)), ...openJobs.filter(job => !ownerIds.has(job.id)), ...ownerJobs]
    })
    await ctx.state.save()
  }
  if (result.managedCapture) await verifyManagedCaptureJobs(ctx, deps, result, await t0RunParams(ctx, deps))
  if (result.build === "passed") sub(ctx, "✓ Build passes", "ok")
  else if (result.build === "failed_baseline") sub(ctx, "The build was already failing before this run (not caused by the install)", "warn")

  const files = result.changedFiles?.length ?? result.edits.length
  const build = result.build === "passed" ? "build passes" : result.build === "failed_baseline" ? "build was already red" : "build not checked yet"
  const open = result.openJobs.length > 0 ? ` · ${result.openJobs.length} file${result.openJobs.length === 1 ? "" : "s"} need${result.openJobs.length === 1 ? "s" : ""} the agent (not live yet)` : ""
  return { kind: "ok", status: `${files} file${files === 1 ? "" : "s"} written · ${build}${open}${ownerJobs.length ? ` · ${ownerJobs.length} owner-only wiring step${ownerJobs.length === 1 ? "" : "s"} left for you` : ""}` }
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
