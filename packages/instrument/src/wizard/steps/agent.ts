// Step `agent` (§3d.1 #1, lane O3): find the user's own Claude Code / Codex, check they are logged in and
// which plan or key pays (no prompt spent), notice nested mode, and choose who works and who reviews.
// Its LAST act is `runs.start({worker, reviewer})` → the cloud `runId` (R1-11: the run record needs both,
// and they are only known here).
//
// Defaults (BUILD-PLAN §1.4): Claude Code works and Codex reviews when both are there; with one agent the
// wizard prints a review brief instead; with none the code jobs still run and the agent jobs are listed for
// the user. The wizard never installs an agent and never switches the user to Infinite-paid inference.
import { bridgeFailureOutcome } from "../../bridge/outcomes.js"
import { createHash } from "node:crypto"

import { AGENT_LABEL } from "../../agents/narration.js"
import { sanitizeUntrusted } from "../../agents/sanitize.js"
import { repoFingerprint } from "../../agents/repo-fingerprint.js"
import { AGENT_MODELS } from "../../agents/runner.js"
import type { AgentInfo, AgentReviewerKind, AgentWorkerKind } from "../contracts/agents.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { blockingDirtyPaths, dirtyTreeMessage } from "../leftovers.js"

const META = WIZARD_STEP_META.agent

export const step: WizardStep<"agent"> = {
  id: "agent",
  title: META.title,
  who: [...META.who],
  learn: META.learn,
  requiredCapabilities: [...META.requiredCapabilities],
  inputHash(ctx: WizardContext): string {
    // Reads optional-chained: F0's structural test hashes an empty context.
    const options: Partial<WizardContext["options"]> = ctx.options ?? {}
    const { worker = null, noAgent = false, nested = false } = options
    const reviewer = reviewerPick(ctx)
    const linkId = ctx.state?.get().link?.linkId ?? null
    return `sha256:${createHash("sha256").update(JSON.stringify({ worker, reviewer, noAgent, nested, linkId })).digest("hex")}`
  },
  run
}

/**
 * Live run 5 (P3): the reviewer the user asked for: this run's `--reviewer`, else the explicit choice an earlier run of
 * this wizard run remembered. Run 5's plain re-run forgot `--reviewer brief`, re-detected the out-of-usage Codex and
 * parked again.
 */
function reviewerPick(ctx: WizardContext): WizardContext["options"]["reviewer"] {
  return ctx.options?.reviewer ?? ctx.state?.get().agent?.reviewerChoice ?? null
}

async function run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  const missing = META.requiredCapabilities.filter((capability) => !deps.bridge.has(capability))
  if (missing.length > 0) {
    return { kind: "failed", code: "INF_WIZ_BRIDGE_PROTOCOL", message: `The Infinite app is missing ${missing.join(", ")}; update the app.`, next: "halt" }
  }
  const sub = (text: string, tone: "ok" | "warn" | "info" | "pending") => ctx.emit.emit("step.sub", { step: "agent", text, tone })
  sub("Looking for Claude Code and Codex…", "pending")
  const detected = await deps.agents.detect()
  const nested = ctx.options.nested || detected.nested !== null
  const available = [detected.worker, detected.reviewer].filter((info): info is AgentInfo => info !== null)

  let worker: AgentInfo | null = null
  if (!nested && !ctx.options.noAgent) {
    const wanted = ctx.options.worker === "codex" ? "codex" : ctx.options.worker === "claude" ? "claude_code" : null
    worker = (wanted ? available.find((info) => info.kind === wanted) : null) ?? detected.worker ?? available[0] ?? null
    if (wanted && worker && worker.kind !== wanted) sub(`${AGENT_LABEL[wanted]} isn't ready here: ${AGENT_LABEL[worker.kind]} does the work`, "warn")
  }

  let reviewerInfo: AgentInfo | null = null
  let reviewer: AgentReviewerKind
  const pick = reviewerPick(ctx)
  if (nested) reviewer = "brief"
  else if (pick === "none") reviewer = "none"
  else if (pick === "brief") reviewer = "brief"
  else {
    const wanted = pick === "codex" ? "codex" : pick === "claude" ? "claude_code" : null
    reviewerInfo =
      (wanted ? available.find((info) => info.kind === wanted && info.kind !== worker?.kind) : null) ??
      available.find((info) => info.kind !== worker?.kind) ??
      null
    reviewer = reviewerInfo ? reviewerInfo.kind : "brief"
  }

  for (const entry of detected.unavailable ?? []) {
    sub(`${AGENT_LABEL[entry.kind]}: ${entry.reason === "not_installed" ? "not installed" : "not logged in"}`, "info")
  }
  if (nested) {
    sub("Started by an agent: it does the agent jobs, and the wizard checks every one itself", "info")
  } else if (worker) {
    const model = AGENT_MODELS[worker.kind]
    sub(`✓ ${AGENT_LABEL[worker.kind]} ${worker.version} · logged in · ${worker.whoPays.label}`, worker.whoPays.payer === "plan" ? "ok" : "warn")
    sub(`${AGENT_LABEL[worker.kind]} runs ${model.label} at ${model.effort} effort; Infinite pays nothing`, "info")
  } else {
    sub("No agent: the code jobs still run; the agent jobs are listed for you", "warn")
  }
  if (reviewerInfo) sub(`✓ ${AGENT_LABEL[reviewerInfo.kind]} found · will review the pull request · ${reviewerInfo.whoPays.label}`, "ok")
  else if (reviewer === "brief" && !nested) sub("One agent only: the wizard will print a review brief for any agent", "info")

  const workerKind: AgentWorkerKind = worker ? worker.kind : "none"
  // Review P2-3: compared with what the cloud row last acknowledged, never with the previous run's local choice.
  const cloudReviewer = ctx.state.get().agent?.cloudReviewer
  ctx.state.update((state) => {
    const previous = state.agent
    state.agent = {
      worker: worker ? worker.kind : null,
      reviewer: reviewer === "none" ? null : reviewer,
      // A session survives only for the same worker (a resume after a usage limit).
      workerSession: previous && previous.worker === (worker?.kind ?? null) ? previous.workerSession : null,
      whoPays: { worker: worker?.whoPays ?? null, reviewer: reviewerInfo?.whoPays ?? null },
      // B22: the model and effort each role runs with (a fallback to the user's default is recorded later).
      models: {
        worker: worker ? (previous?.models?.worker && previous.worker === worker.kind ? previous.models.worker : { model: AGENT_MODELS[worker.kind].model, effort: AGENT_MODELS[worker.kind].effort, fallback: false }) : null,
        reviewer: reviewerInfo ? { model: AGENT_MODELS[reviewerInfo.kind].model, effort: AGENT_MODELS[reviewerInfo.kind].effort, fallback: false } : null
      },
      ...(pick !== null ? { reviewerChoice: pick } : {}),
      ...(cloudReviewer !== undefined ? { cloudReviewer } : {})
    }
  })

  const existing = ctx.state.get().runId
  if (existing) {
    ctx.runId = existing
    await ctx.state.save()
    // Live run 5 (P3): the cloud run row records who reviews. A reviewer changed on a re-run is sent, so the row never
    // keeps the first run's reviewer (run 5's row said codex for a review posted from the brief).
    if (cloudReviewer !== reviewer && deps.bridge.has("tag.runs.reviewer.v1")) {
      // Review 2 P3-b: the row's reviewer is a record, not a step's work. A patch that fails (an older cloud refuses the
      // field, the network) is said and retried on the next run (`cloudReviewer` stays as the cloud last acknowledged);
      // it never stops the run. A stopped run still stops.
      try {
        await deps.bridge.patchRun(existing, { reviewer }, { signal: ctx.signal })
        ctx.state.update((state) => {
          if (state.agent) state.agent.cloudReviewer = reviewer
        })
        await ctx.state.save()
      } catch (error) {
        if (ctx.signal.aborted) throw error
        sub(`! Infinite did not record the reviewer change (${sanitizeUntrusted(error instanceof Error ? error.message : String(error), 160)}); it is sent again on the next run.`, "warn")
      }
    }
    return { kind: "ok", status: statusLine(worker, reviewerInfo, reviewer, nested) }
  }
  // §3y.8 (P3-11): the repo and clean-tree preconditions BEFORE the cloud run exists, so a dirty tree never leaves
  // a run open at `before` in Infinite (the same exemptions as `before`: `.gitignore` and `.infinite/`).
  if (!(await deps.git.isRepo())) {
    return { kind: "failed", code: "INF_WIZ_NO_GIT", message: "This folder is not a git repository. Run npx infinite-tag in your website's repo.", next: "halt" }
  }
  const dirty = blockingDirtyPaths((await deps.git.cleanTree()).dirtyPaths)
  if (dirty.length > 0) return { kind: "failed", code: "INF_WIZ_DIRTY_TREE", message: dirtyTreeMessage(dirty), next: "halt" }
  // LAST: start the cloud run with the worker and reviewer (R1-11).
  const fingerprint = await repoFingerprint({ remoteUrl: await deps.git.remoteUrl(), root: ctx.root, appRoot: ctx.appRoot })
  let runId: string
  let runStartedAt: string
  try {
    const started = await deps.bridge.startRun({ tagVersion: deps.tagVersion, repoFingerprint: fingerprint, worker: workerKind, reviewer }, { signal: ctx.signal })
    runId = started.runId
    runStartedAt = started.startedAt
  } catch (error) {
    const mapped = bridgeOutcome(error)
    if (mapped) return mapped
    throw error
  }
  ctx.runId = runId
  ctx.state.update((state) => {
    state.runId = runId
    state.runStartedAt = runStartedAt
    if (state.agent) state.agent.cloudReviewer = reviewer
  })
  await ctx.state.save()
  return { kind: "ok", status: statusLine(worker, reviewerInfo, reviewer, nested) }
}

function statusLine(worker: AgentInfo | null, reviewerInfo: AgentInfo | null, reviewer: AgentReviewerKind, nested: boolean): string {
  if (nested) return "The agent that started the wizard does the agent jobs · the wizard checks them"
  const work = worker ? `${AGENT_LABEL[worker.kind]} does the work` : "No agent: deterministic lanes only"
  const review = reviewerInfo ? `${AGENT_LABEL[reviewerInfo.kind]} reviews it` : reviewer === "brief" ? "a review brief is printed" : "no second review"
  return `${work} · ${review}`
}

/** The bridge failures this step turns into an outcome (§3z.4, one table); anything else is thrown to the engine. */
function bridgeOutcome(error: unknown): StepOutcome | null {
  return bridgeFailureOutcome(error)
}
