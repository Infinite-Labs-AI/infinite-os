import { planExclusions } from "../../install/plan-exclusions.js"
import { ownerLayoutJobs } from "./install.js"
// Step `plan` (§3d.1 step 4, lane O7): "Plan + your decisions".
//
// Builds the PlanModel, opens ONE `plan` ask (the only questions: consent mode, conversion names,
// plus explicit package/account choices; repository work is shown), persists the answers and the plan hash,
// applies the approvals to the seeded candidates (`JobRegistry.applyApprovals`, then the seeding gate),
// and PATCHes the run's `approvedConversions`. A missing consent mode ALWAYS parks the run here
// (INF_WIZ_NEEDS_ANSWERS, exit 3): `install` cannot create the site source without it.
import { createHash } from "node:crypto"

import { agentJobsUpTo, gateSeededItems, planAsksConsent, resolvePlanAnswers, runnableAgentJobs, withGuardHosts, type WizardPlanModel } from "../../install/plan-model.js"
import { keysOnly, loadPlanApprovals, loadPlanInputs, planCandidates, savePlanApprovals } from "../../install/step-inputs.js"
import { withDistinctTitles } from "../../jobs/registry.js"
import { ASK_CANCELLED, ASK_TIMEOUT } from "../contracts/asks.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"

const meta = WIZARD_STEP_META.plan

const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`

const PARK_HINT = "Run `npx infinite-tag --resume` and answer the plan (or pass --consent-mode required|not_required)."

function sub(ctx: WizardContext, text: string, tone: "ok" | "warn" | "info" | "pending" | "result"): void {
  ctx.emit.emit("step.sub", { step: "plan", text, tone })
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  sub(ctx, "Writing the plan…", "pending")
  const inputs = await loadPlanInputs(ctx, deps)
  if ("missingCapability" in inputs) {
    return { kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL", message: `The Infinite app does not offer ${inputs.missingCapability}; update the app.`, next: "halt" }
  }
  if (!inputs.liveFacts) sub(ctx, "The live-site check's measurements are not available; measured values show —", "warn")

  const scan = await deps.installer.scan({ root: ctx.root, ...(ctx.appRoot !== "." ? { appRoot: ctx.appRoot } : {}), hosting: inputs.hosting })
  let candidates = await planCandidates(ctx, deps)
  const originalCandidates = candidates
  const plan = deps.installer.buildPlan(scan, keysOnly(inputs.keys), inputs.before, candidates)
  candidates = (plan as Partial<WizardPlanModel>).scopedCandidates ?? candidates
  // §3y.5 (P2-8): ONE count: the plan's own budget line ("up to N"), this line, "Plan approved" and "Job i/N" all
  // come from `agentJobsAfterApprovals` (the registry's gate + the plan's gate; withheld and unrunnable jobs out).
  const agentJobs = agentJobsUpTo(candidates, (plan as Partial<WizardPlanModel>).seeds ?? [], plan, ctx.options.consentMode)
  const wiring = (plan as Partial<WizardPlanModel>).ownerWiring
  if (wiring?.canWire === false && agentJobs === 0 && ![...candidates, ...((plan as Partial<WizardPlanModel>).seeds ?? [])].some(item => item.owner === "code" && item.state !== "left_for_you" && item.state !== "blocked")) {
    return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: plan.lines.find(line => line.id === "user_action:owner_wiring")!.text, resumeHint: "Add the wiring above yourself, then run npx infinite-tag again." }
  }
  const decisions = plan.lines.filter((line) => line.editable).length
  sub(ctx, `Up to ${agentJobs} agent job${agentJobs === 1 ? "" : "s"} · ${decisions} decision${decisions === 1 ? "" : "s"} need${decisions === 1 ? "s" : ""} you`, "info")

  // A resume of the SAME plan with its consent already answered asks nothing again (the saved answer
  // carries the selected conversion names too).
  const saved = ctx.state.get().plan
  const savedFile = await loadPlanApprovals(ctx, deps)
  const earlierNo = [...new Set([...(savedFile?.excluded ?? savedFile?.approvals.declined ?? saved?.lines.filter(line => line.approved === false).map(line => line.id) ?? [])])]
  let answer =
    !ctx.options.answersFile && saved && saved.hash === plan.hash && (saved.answers.consentMode !== null || !planAsksConsent(plan)) && savedFile?.planHash === plan.hash ? savedFile.approvals : null
  if (!answer) {
    const asked = await deps.installer.planAsk(plan)
    const reply = await ctx.ask("plan", { ...asked, excluded: earlierNo.filter(id => plan.lines.some(line => line.id === id)) })
    if (reply === ASK_CANCELLED || reply === ASK_TIMEOUT) {
      ctx.state.update((state) => {
        state.plan = {
          hash: plan.hash,
          answers: { consentMode: null, conversions: [], privacyApproved: null, npmInstall: null, metaGoal: null },
          lines: plan.lines.map((line) => ({ id: line.id, approved: earlierNo.includes(line.id) ? false : null }))
        }
      })
      await ctx.state.save()
      return { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "The plan was not answered.", resumeHint: PARK_HINT }
    }
    answer = reply
  }

  const currentAnswer = answer
  const keptNo = earlierNo.filter(id => !currentAnswer.approved.includes(id) || currentAnswer.declined.includes(id))
  answer = { ...answer, declined: [...new Set([...keptNo, ...answer.declined])] }
  for (const id of answer.declined) sub(ctx, `${keptNo.includes(id) ? "kept your earlier no to" : "You said no to"}: ${plan.lines.find(line => line.id === id)?.text ?? id}`, "result")
  for (const text of planExclusions(plan, answer.declined).consequences) sub(ctx, text, "result")
  const resolved = resolvePlanAnswers(plan, answer, { consentFlag: ctx.options.consentMode })
  for (const line of plan.lines) {
    if (line.requires === "approval" && resolved.lines.find(entry => entry.id === line.id)?.approved === null) sub(ctx, `Not turned on: ${line.text}`, "result")
  }
  ctx.state.update((state) => {
    state.plan = {
      hash: plan.hash,
      answers: {
        consentMode: resolved.consentMode,
        conversions: resolved.conversions,
        privacyApproved: resolved.privacyApproved,
        npmInstall: resolved.npmInstall,
        metaGoal: resolved.metaGoal
      },
      lines: resolved.lines
    }
  })
  await savePlanApprovals(ctx, deps, {
    planHash: plan.hash,
    mode: "shown_and_continued",
    ownerWiring: (plan as Partial<WizardPlanModel>).ownerWiring,
    beforeAt: ctx.state.get().steps.before?.at ?? null,
    candidates: originalCandidates,
    approvals: resolved.approvals,
    excluded: answer.declined,
    privacyText: resolved.privacyText,
    guard: (plan as Partial<WizardPlanModel>).guard ?? null,
    plan: { hash: plan.hash, lines: plan.lines, decisions: plan.decisions }
  })

  // R2-6: a plan that does not ask consent (nothing it governs is installed or recorded) needs no answer.
  if (resolved.consentMode === null && planAsksConsent(plan)) {
    await ctx.state.save()
    return {
      kind: "parked",
      code: "INF_WIZ_NEEDS_ANSWERS",
      reason: "The consent mode is unanswered, so the site source cannot be created.",
      resumeHint: PARK_HINT
    }
  }

  // The approved lines decide which candidates become jobs; the gate re-checks the adopted-provider rule.
  // The plan's own seeds (an improve line no detector candidate links) pass the same gate, so an
  // approved line always has a job or a code edit behind it.
  const wizardPlan = plan as Partial<WizardPlanModel>
  // ONE seeding gate (§3z.12 B13): the detector candidates AND the plan's own improve seeds go through the
  // registry's `applyApprovals` (its per-target line-kind table); `gateSeededItems` stays defence in depth.
  const seeds = (wizardPlan.seeds ?? []).filter((seed) => !candidates.some((item) => item.id === seed.id))
  const applied = deps.registry.applyApprovals([...candidates, ...seeds], plan, resolved.approvals)
  const items = withDistinctTitles(withGuardHosts(gateSeededItems(plan, resolved, applied), wizardPlan.guard ?? null))
  ctx.state.update((state) => {
    state.jobs = [...items, ...ownerLayoutJobs(wizardPlan.ownerWiring?.requirements ?? []).filter(job => !items.some(item => item.id === job.id))]
  })
  await ctx.state.save()

  if (resolved.conversions.length > 0 && planExclusions(plan, resolved.approvals.declined).conversionWrites) {
    if (ctx.runId) {
      await deps.bridge.patchRun(ctx.runId, { approvedConversions: resolved.conversions }, { signal: ctx.signal })
    } else {
      sub(ctx, "No Infinite run yet: the approved conversions are saved locally only", "warn")
    }
  }

  const approved = resolved.lines.filter((line) => line.approved === true).length
  // The jobs that RUN (the jobs step's "Job i/N" counts the same items); the ones waiting for you are said apart.
  const running = runnableAgentJobs(items).length
  const blocked = items.filter((item) => item.owner === "agent" && item.state === "blocked").length
  return {
    kind: "ok",
    status: `Plan shown and continued · ${approved} action${approved === 1 ? "" : "s"} · ${running} agent job${running === 1 ? "" : "s"}${blocked > 0 ? ` (${blocked} more wait${blocked === 1 ? "s" : ""} for you)` : ""}`
  }
}

export const step: WizardStep<"plan"> = {
  id: "plan",
  title: meta.title,
  who: [...meta.who],
  learn: meta.learn,
  requiredCapabilities: [...meta.requiredCapabilities],
  /**
   * The scan summary, keys and candidates all come from the `before` run (its identity stands for
   * them), plus `--consent-mode`. The answers are this step's OUTPUT, so they are not an input.
   */
  inputHash(ctx) {
    // Optional chaining: the engine always passes a full context; the structure test passes `{}`.
    const before = ctx.state?.get().steps.before
    return sha256(
      JSON.stringify({
        step: "plan",
        before: before ? { at: before.at, inputHash: before.inputHash } : null,
        consentFlag: ctx.options?.consentMode ?? null
      })
    )
  },
  run
}
