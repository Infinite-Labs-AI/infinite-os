// The wizard engine: `runWizard(ctx, deps)` runs the 13 steps (§3d.1) in `WIZARD_STEP_IDS` order through
// the step Record, with resume, a per-step budget, the run's AbortSignal, outcome → next step / park /
// halt, the §3d.5 exit code, and the ENGINE INVARIANT (§3a.9.4): no state-changing bridge verb while an
// agent child is alive.
//
// It generalises the harness runbook (`../harness/runbook.ts` `runRunbook`): one id list is the order,
// each step returns an outcome, the first halt stops the run. What is new here: steps can PARK (exit 3,
// resumable), the run state is saved after every step so a resume skips what is done, and the exit code
// is a function of the CODE that halted or parked the run (R1-36), never of the outcome kind.
import type { AgentRunner } from "./contracts/agents.js"
import {
  BRIDGE_VERBS,
  BRIDGE_VERB_IDS,
  type BridgeVerbId,
  type TagBridgeClient,
  type TagCapability
} from "./contracts/bridge.js"
import { WIZARD_EXIT, runExitCode, type WizardCode } from "./contracts/codes.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep, WizardStepRecord } from "./contracts/deps.js"
import { WIZARD_STEP_IDS, type WizardStepId } from "./contracts/steps.js"
import { ensureWizardGitignoreFence } from "../harness/marking.js"
import { WIZARD_STEPS } from "./steps/index.js"

// ---------------------------------------------------------------------------------------------
// The engine invariant (§3a.9.4)
// ---------------------------------------------------------------------------------------------

/** A programming error, never a user state: the run crashes loudly instead of reporting an outcome. */
export class EngineInvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EngineInvariantError"
  }
}

/** Every `TagBridgeClient` verb method and the §3a verb it calls (a test holds this complete). */
export const BRIDGE_METHOD_VERBS = {
  status: "status",
  requestLink: "link.request",
  pollLink: "link.poll",
  revokeLink: "link.revoke",
  keys: "keys",
  hosting: "hosting",
  deployStatus: "hosting.deploy",
  startRun: "runs.start",
  claimProof: "runs.proof-claim",
  patchRun: "runs.patch",
  getRun: "runs.get",
  postReceipts: "receipts",
  postReport: "report",
  baseline: "baseline",
  ensureSiteSource: "site-source",
  declareConversions: "conversions",
  markGa4KeyEvents: "ga4-key-events",
  serverLaneStatus: "server-lane.status",
  provisionServerLaneEnv: "server-lane.provision-env",
  metaRelayStatus: "meta-relay.status",
  enableMetaRelay: "meta-relay.enable",
  removeServerLaneEnv: "uninstall.remove-env",
  disableSiteSource: "uninstall.disable-site-source",
  siteClaim: "site-claim",
  readSiteClaim: "site-claim-read",
  proveSite: "site-prove",
  startTest: "test.start",
  pollTest: "test.poll",
  cancelTest: "test.cancel",
  testFacts: "test.facts"
} as const satisfies Record<Exclude<keyof TagBridgeClient, "descriptor" | "has" | "setLinkId">, BridgeVerbId>

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(
  Object.entries(BRIDGE_METHOD_VERBS)
    .filter(([, verb]) => BRIDGE_VERBS[verb].stateChanging)
    .map(([method]) => method)
)

/** True when every verb in the §3a table has a client method (the map is complete). */
export function bridgeMethodMapIsComplete(): boolean {
  const mapped = new Set<string>(Object.values(BRIDGE_METHOD_VERBS))
  return BRIDGE_VERB_IDS.every((verb) => mapped.has(verb))
}

/**
 * The bridge every step gets: identical to the real one, except that a state-changing verb called while
 * an agent child is alive throws `EngineInvariantError` before anything is sent.
 */
export function guardBridge(bridge: TagBridgeClient, agents: Pick<AgentRunner, "isAgentAlive">): TagBridgeClient {
  return new Proxy(bridge, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof property !== "string" || typeof value !== "function") return value
      if (!STATE_CHANGING_METHODS.has(property)) return value.bind(target)
      return (...args: unknown[]) => {
        if (agents.isAgentAlive()) {
          throw new EngineInvariantError(
            `Engine invariant: ${property} (${BRIDGE_METHOD_VERBS[property as keyof typeof BRIDGE_METHOD_VERBS]}) changes state and an agent is still running.`
          )
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    }
  })
}

/** Nested mode (§3d.7): no agent is ever spawned. A step that tries is a programming error. */
export function nestedAgents(agents: AgentRunner): AgentRunner {
  return {
    detect: () => agents.detect(),
    isAgentAlive: () => agents.isAgentAlive(),
    killAll: () => agents.killAll(),
    runJobs: async () => {
      throw new EngineInvariantError("Nested mode: the parent agent does the jobs; the wizard spawns no agent.")
    },
    review: async () => {
      throw new EngineInvariantError("Nested mode: the wizard spawns no reviewer; it prints the review brief.")
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------------

/** A step's wall-clock budget and the outcome it ends with when the budget runs out. */
export interface StepBudget {
  ms: number
  onOverrun: StepOutcome
}

/**
 * The default budgets: a safety net above each step's own limits (link approval 5 min; the agent's 10
 * min jobs budget; the deploy wait). A step without a meaningful overrun code has no engine budget.
 */
export const DEFAULT_STEP_BUDGETS: Partial<Record<WizardStepId, StepBudget>> = {
  link: {
    ms: 6 * 60_000,
    onOverrun: { kind: "failed", code: "INF_WIZ_LINK_EXPIRED", message: "The link was not approved in time.", next: "halt" }
  },
  // The agent's own budget is 10 minutes; builds and T0 between resume rounds come on top, so this only
  // catches a wedged step.
  jobs: {
    ms: 40 * 60_000,
    onOverrun: { kind: "failed", code: "INF_WIZ_AGENT_TIMEOUT", message: "The agent jobs ran past their time budget.", next: "halt" }
  },
  prove: {
    ms: 45 * 60_000,
    onOverrun: {
      kind: "parked",
      code: "INF_WIZ_DEPLOY_TIMEOUT",
      reason: "The deploy was not seen in time.",
      resumeHint: "Open Infinite: it finishes the proof after the deploy. Or run npx infinite-tag again."
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------------------------

export interface EngineStepEvent {
  step: WizardStepId
  outcome: StepOutcome
  /** True when the step did not run because an earlier run finished it with the same inputs. */
  resumedSkip: boolean
}

export interface EngineOptions {
  /** The step Record (tests pass fakes); default the real 13 steps. */
  steps?: WizardStepRecord
  budgets?: Partial<Record<WizardStepId, StepBudget>>
  /**
   * Runs after each step's outcome is recorded. Default: write the gitignore fence after `before` is ok
   * (so it lands on the wizard's branch, after `before`'s branch switch).
   */
  afterStep?: (event: EngineStepEvent, ctx: WizardContext, deps: WizardDeps) => Promise<void>
  /** The step a resume starts from (for `run.start`). */
  resumedFrom?: WizardStepId | null
  /**
   * §3d.6: a resumed run whose pull request is already MERGED jumps to this step (`merge`, which records the
   * merge commit and hands over to `prove`). Every earlier step that ran before is skipped, except `link`
   * (every process re-attaches its link): nothing re-commits, re-opens a pull request or re-reviews it.
   */
  resumeAt?: WizardStepId | null
  /**
   * The fence's snapshot restore (lane O3). After a budget overrun the engine kills the agents, waits for
   * the step to settle (at most `settleMs`), then restores the snapshot, so the run never moves on (or
   * releases its lock) while an overrun step is still writing.
   */
  fenceAbort?: () => Promise<void>
  /** How long an overrun step gets to unwind after its abort (default STEP_SETTLE_MS). */
  settleMs?: number
}

/** How long an overrun step gets to unwind after the engine aborts it. */
export const STEP_SETTLE_MS = 30_000

export interface EngineResult {
  exitCode: number
  interrupted: boolean
  /** The step that halted or parked the run (null when it ran to the end or was interrupted between steps). */
  stoppedAt: WizardStepId | null
  events: EngineStepEvent[]
  /** The codes of the outcomes that halted or parked the run. */
  haltingCodes: WizardCode[]
}

export async function defaultAfterStep(event: EngineStepEvent, ctx: WizardContext): Promise<void> {
  if (event.step === "before" && (event.outcome.kind === "ok" || (event.resumedSkip && event.outcome.kind === "skipped"))) {
    ensureWizardGitignoreFence(ctx.root)
  }
}

function missingCapabilities(step: WizardStep<WizardStepId>, bridge: TagBridgeClient): TagCapability[] {
  // `link` discovers the bridge itself (no descriptor → NO_APP / NOT_MAC), so it checks its own.
  if (step.id === "link") return []
  return step.requiredCapabilities.filter((capability) => !bridge.has(capability))
}

function outcomeReason(outcome: StepOutcome): string | undefined {
  switch (outcome.kind) {
    case "ok":
      return undefined
    case "skipped":
      return outcome.reason
    case "parked":
      return `${outcome.reason} ${outcome.resumeHint}`.trim()
    case "blocked":
      return outcome.reason
    case "failed":
      return outcome.message
  }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError")
}

async function runWithBudget(
  step: WizardStep<WizardStepId>,
  ctx: WizardContext,
  deps: WizardDeps,
  budget: StepBudget | undefined,
  overrun: { fenceAbort?: () => Promise<void>; settleMs: number }
): Promise<{ outcome: StepOutcome; overran: boolean }> {
  if (!budget) return { outcome: await step.run(ctx, deps), overran: false }
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(ctx.signal.reason)
  ctx.signal.addEventListener("abort", onParentAbort, { once: true })
  const stepCtx: WizardContext = Object.create(ctx, { signal: { value: controller.signal, enumerable: true } })
  let timer: ReturnType<typeof setTimeout> | null = null
  const ranOut = new Promise<"overrun">((resolve) => {
    timer = setTimeout(() => resolve("overrun"), budget.ms)
  })
  const running = step.run(stepCtx, deps)
  try {
    const result = await Promise.race([running, ranOut])
    if (result === "overrun") {
      // Stop the step, kill the agent tree, let the step unwind (bounded), then restore the snapshot:
      // nothing may still be writing when the run moves on or releases its lock.
      controller.abort(new Error(`step ${step.id} ran past its budget`))
      await deps.agents.killAll()
      let settleTimer: ReturnType<typeof setTimeout> | null = null
      await Promise.race([
        running.then(
          () => undefined,
          () => undefined
        ),
        new Promise<void>((resolve) => {
          settleTimer = setTimeout(resolve, overrun.settleMs)
        })
      ])
      if (settleTimer) clearTimeout(settleTimer)
      if (overrun.fenceAbort) await overrun.fenceAbort()
      return { outcome: budget.onOverrun, overran: true }
    }
    return { outcome: result, overran: false }
  } finally {
    if (timer) clearTimeout(timer)
    ctx.signal.removeEventListener("abort", onParentAbort)
  }
}

/**
 * Runs the wizard. `deps.bridge` and (in nested mode) `deps.agents` are wrapped by the engine, so every
 * step sees the guarded versions. The state is saved after every step.
 */
export async function runWizard(ctx: WizardContext, rawDeps: WizardDeps, options: EngineOptions = {}): Promise<EngineResult> {
  const agents = ctx.options.nested ? nestedAgents(rawDeps.agents) : rawDeps.agents
  const deps: WizardDeps = { ...rawDeps, agents, bridge: guardBridge(rawDeps.bridge, agents) }
  const steps = options.steps ?? WIZARD_STEPS
  const budgets = options.budgets ?? DEFAULT_STEP_BUDGETS
  const afterStep = options.afterStep ?? defaultAfterStep
  const events: EngineStepEvent[] = []
  const haltingCodes: WizardCode[] = []

  const initial = ctx.state.get()
  ctx.emit.emit("run.start", {
    runId: initial.runId,
    displayId: initial.displayId,
    tagVersion: rawDeps.tagVersion,
    root: ctx.root,
    appRoot: ctx.appRoot,
    ...(options.resumedFrom ? { resumedFrom: options.resumedFrom } : {})
  })

  const interrupted = (): EngineResult => ({ exitCode: WIZARD_EXIT.interrupted, interrupted: true, stoppedAt: null, events, haltingCodes })

  for (const id of WIZARD_STEP_IDS) {
    if (ctx.signal.aborted) return interrupted()
    const step = steps[id] as WizardStep<WizardStepId>
    const hash = step.inputHash(ctx)
    const previous = ctx.state.get().steps[id]

    const beforeResumePoint =
      options.resumeAt != null && id !== "link" && previous !== undefined && WIZARD_STEP_IDS.indexOf(id) < WIZARD_STEP_IDS.indexOf(options.resumeAt)
    if ((previous?.outcome === "ok" && previous.inputHash === hash) || beforeResumePoint) {
      const outcome: StepOutcome = {
        kind: "skipped",
        reason: previous?.outcome === "ok" && previous.inputHash === hash ? "Done in an earlier run; its inputs are unchanged." : "The pull request is already merged."
      }
      ctx.emit.emit("step.start", { step: id })
      ctx.emit.emit("step.done", { step: id, outcome: "skipped", reason: outcome.reason })
      const event = { step: id, outcome, resumedSkip: true }
      events.push(event)
      await afterStep(event, ctx, deps)
      continue
    }

    ctx.emit.emit("step.start", { step: id })
    let outcome: StepOutcome
    const missing = missingCapabilities(step, deps.bridge)
    if (missing.length > 0) {
      outcome = {
        kind: "failed",
        code: "INF_WIZ_BRIDGE_PROTOCOL",
        message: missing.includes("tag.test.v2")
          ? // §3x.5: an older test engine announces itself as a monitor; Meta's pixel ignores it, so its grades are wrong.
            "The Infinite app is missing tag.test.v2; update the app (its test window is identified as a monitor, so Meta's pixel ignores it)."
          : `The Infinite app is too old for this step (missing ${missing.join(", ")}). Update Infinite, then run npx infinite-tag again.`,
        next: "halt"
      }
    } else {
      try {
        // Nested mode (§3d.7) has ONE implementation: the `jobs` step's own nested branch (B8).
        outcome = (
          await runWithBudget(step, ctx, deps, budgets[id], {
            ...(options.fenceAbort ? { fenceAbort: options.fenceAbort } : {}),
            settleMs: options.settleMs ?? STEP_SETTLE_MS
          })
        ).outcome
      } catch (error) {
        if (error instanceof EngineInvariantError) throw error
        if (isAbort(error, ctx.signal)) return interrupted()
        // A step that throws has a bug; record where the run stopped, then let the command report it.
        ctx.state.update((state) => {
          state.steps[id] = { outcome: "failed", inputHash: hash, at: ctx.now().toISOString() }
        })
        await ctx.state.save()
        ctx.emit.emit("step.done", { step: id, outcome: "failed", reason: error instanceof Error ? error.message : String(error) })
        throw error
      }
    }
    if (ctx.signal.aborted) return interrupted()

    ctx.state.update((state) => {
      state.steps[id] = {
        outcome: outcome.kind,
        inputHash: hash,
        at: ctx.now().toISOString(),
        ...(outcome.kind === "parked" || outcome.kind === "blocked" || outcome.kind === "failed" ? { code: outcome.code } : {})
      }
    })
    await ctx.state.save()

    if (outcome.kind === "ok") ctx.emit.emit("step.status", { step: id, text: outcome.status })
    const reason = outcomeReason(outcome)
    ctx.emit.emit("step.done", {
      step: id,
      outcome: outcome.kind,
      ...(outcome.kind === "parked" || outcome.kind === "blocked" || outcome.kind === "failed" ? { code: outcome.code } : {}),
      ...(reason ? { reason } : {})
    })
    const event = { step: id, outcome, resumedSkip: false }
    events.push(event)
    await afterStep(event, ctx, deps)

    const stops =
      outcome.kind === "parked" || outcome.kind === "blocked" || (outcome.kind === "failed" && outcome.next === "halt")
    if (stops && outcome.kind !== "ok" && outcome.kind !== "skipped") {
      haltingCodes.push(outcome.code)
      return { exitCode: runExitCode(haltingCodes), interrupted: false, stoppedAt: id, events, haltingCodes }
    }
  }
  return { exitCode: runExitCode(haltingCodes), interrupted: false, stoppedAt: null, events, haltingCodes }
}
