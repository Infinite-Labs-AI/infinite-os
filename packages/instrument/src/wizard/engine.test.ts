import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  CallLog,
  createFakeAgents,
  createFakeBridge,
  defaultOptions,
  fakeDeps
} from "../../test/wizard/runtime-fakes.js"
import { STATE_CHANGING_VERBS } from "./contracts/bridge.js"
import { WIZARD_CODES, WIZARD_CODE_EXIT, type WizardCode } from "./contracts/codes.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep, WizardStepRecord } from "./contracts/deps.js"
import type { WizardEvent } from "./contracts/events.js"
import { WIZARD_STEP_IDS, WIZARD_STEP_META, type WizardStepId } from "./contracts/steps.js"
import { createWizardAsks } from "./asks.js"
import {
  BRIDGE_METHOD_VERBS,
  EngineInvariantError,
  bridgeMethodMapIsComplete,
  guardBridge,
  runWizard,
  type EngineOptions
} from "./engine.js"
import { WizardEventEmitter } from "./events.js"
import { nodeWizardFs } from "./fs.js"
import { RunStateFile, createRunState, loadRunState } from "./run-state.js"
import { WizardStore } from "./store.js"
import { GITIGNORE_FENCE_BLOCK } from "../harness/outputs.js"

const roots: string[] = []
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "wizard-engine-"))
  roots.push(root)
  return root
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

type Behaviour = (ctx: WizardContext, deps: WizardDeps) => Promise<StepOutcome>

/** A step Record whose steps record their runs; each step's input hash is `hashes[id]` (default "h"). */
function fakeSteps(behaviours: Partial<Record<WizardStepId, Behaviour>>, ran: WizardStepId[], hashes: Partial<Record<WizardStepId, string>> = {}): WizardStepRecord {
  const make = <Id extends WizardStepId>(id: Id): WizardStep<Id> => ({
    id,
    title: WIZARD_STEP_META[id].title,
    who: [...WIZARD_STEP_META[id].who],
    learn: WIZARD_STEP_META[id].learn,
    requiredCapabilities: [...WIZARD_STEP_META[id].requiredCapabilities],
    inputHash: () => hashes[id] ?? "h",
    run: async (ctx, deps) => {
      ran.push(id)
      const behaviour = behaviours[id]
      return behaviour ? behaviour(ctx, deps) : { kind: "ok", status: `${id} ok` }
    }
  })
  return Object.fromEntries(WIZARD_STEP_IDS.map((id) => [id, make(id)])) as unknown as WizardStepRecord
}

async function setup(options: { nested?: boolean; yes?: boolean; root?: string } = {}) {
  const root = options.root ?? tempRoot()
  const bundle = fakeDeps()
  const store = new WizardStore({ displayId: "r-7f3c", tagVersion: "0.12.0" })
  const events: WizardEvent[] = []
  const emitter = new WizardEventEmitter({ store, onEvent: (event) => events.push(event) })
  const wizardOptions = defaultOptions({ nested: options.nested ?? false, yes: options.yes ?? false })
  const loaded = await loadRunState(nodeWizardFs, root)
  const state = new RunStateFile(nodeWizardFs, root, loaded.kind === "ok" ? loaded.state : createRunState({ tagVersion: "0.12.0", root, appRoot: ".", now: new Date("2026-10-02T09:00:00Z") }))
  const asks = createWizardAsks({ store, emitter, options: wizardOptions, answers: null, ttyPrompter: null })
  const controller = new AbortController()
  const ctx: WizardContext = {
    get runId() {
      return state.get().runId
    },
    state,
    emit: emitter,
    ask: asks.ask,
    signal: controller.signal,
    options: wizardOptions,
    root,
    appRoot: ".",
    now: () => new Date("2026-10-02T09:00:00Z")
  }
  const run = (steps: WizardStepRecord, extra: EngineOptions = {}) => runWizard(ctx, bundle.deps, { afterStep: async () => {}, ...extra, steps })
  return { root, ctx, run, events, store, controller, ...bundle }
}

describe("runWizard: order, outcomes and exit codes", () => {
  it("runs the 13 steps in WIZARD_STEP_IDS order and exits 0", async () => {
    const { run, events } = await setup()
    const ran: WizardStepId[] = []
    const result = await run(fakeSteps({}, ran))
    expect(ran).toEqual([...WIZARD_STEP_IDS])
    expect(result.exitCode).toBe(0)
    expect(events[0]!.t).toBe("run.start")
    expect(events.filter((event) => event.t === "step.done").map((event) => (event as { step: string }).step)).toEqual([...WIZARD_STEP_IDS])
  })

  it("a failed step with next:continue does not stop the run or set the exit code; a halt does", async () => {
    const ran: WizardStepId[] = []
    const cont = await setup()
    const keepGoing = await cont.run(
      fakeSteps({ review: async () => ({ kind: "failed", code: "INF_WIZ_REVIEW_UNPARSEABLE", message: "no review", next: "continue" }) }, ran)
    )
    expect(ran).toContain("done")
    expect(keepGoing.exitCode).toBe(0)

    const halted: WizardStepId[] = []
    const halt = await setup()
    const stopped = await halt.run(fakeSteps({ install: async () => ({ kind: "failed", code: "INF_WIZ_APPLY_ROLLED_BACK", message: "rolled back", next: "halt" }) }, halted))
    expect(halted.at(-1)).toBe("install")
    expect(halted).not.toContain("jobs")
    expect(stopped).toMatchObject({ exitCode: 1, stoppedAt: "install", haltingCodes: ["INF_WIZ_APPLY_ROLLED_BACK"] })
  })

  it("blocked halts with its code (e.g. no app → exit 4)", async () => {
    const ran: WizardStepId[] = []
    const { run } = await setup()
    const result = await run(fakeSteps({ link: async () => ({ kind: "blocked", code: "INF_WIZ_NO_APP", reason: "Open the Infinite app" }) }, ran))
    expect(ran).toEqual(["link"])
    expect(result.exitCode).toBe(4)
  })

  it("maps EVERY WizardCode that halts or parks the run to its §3d.5 exit code", async () => {
    for (const code of WIZARD_CODES) {
      const ran: WizardStepId[] = []
      const { run } = await setup()
      const result = await run(
        fakeSteps({ plan: async () => ({ kind: "parked", code: code as WizardCode, reason: "r", resumeHint: "h" }) }, ran)
      )
      expect(result.exitCode, code).toBe(WIZARD_CODE_EXIT[code])
    }
  })
})

describe("runWizard: resume", () => {
  it("parked → exit 3, the state is saved, and a reload resumes at the parked step, skipping ok steps with unchanged hashes", async () => {
    const root = tempRoot()
    const first = await setup({ root })
    const ran1: WizardStepId[] = []
    const parked = await first.run(
      fakeSteps({ plan: async () => ({ kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "consent mode", resumeHint: "answer it" }) }, ran1)
    )
    expect(parked).toMatchObject({ exitCode: 3, stoppedAt: "plan" })
    const saved = JSON.parse(readFileSync(join(root, ".infinite/wizard/state.json"), "utf8"))
    expect(saved.steps.plan).toMatchObject({ outcome: "parked", code: "INF_WIZ_NEEDS_ANSWERS" })
    expect(statSync(join(root, ".infinite/wizard/state.json")).mode & 0o777).toBe(0o600)

    const second = await setup({ root })
    const ran2: WizardStepId[] = []
    const resumed = await second.run(fakeSteps({}, ran2))
    expect(resumed.exitCode).toBe(0)
    expect(ran2[0]).toBe("plan")
    expect(ran2).not.toContain("link")
    expect(resumed.events.filter((event) => event.resumedSkip).map((event) => event.step)).toEqual(["link", "agent", "before", "keys"])
  })

  it("an ok step whose input hash changed runs again (negative: an unchanged hash never re-runs)", async () => {
    const root = tempRoot()
    const first = await setup({ root })
    await first.run(fakeSteps({ merge: async () => ({ kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason: "waiting", resumeHint: "merge" }) }, []))
    const second = await setup({ root })
    const ran: WizardStepId[] = []
    await second.run(fakeSteps({}, ran, { rehearsal: "new-head-sha" }))
    // rehearsal re-runs (new hash); review keeps its hash so it is skipped; merge onward were never ok.
    expect(ran).toEqual(["rehearsal", "merge", "prove", "done"])
    expect(ran).not.toContain("jobs")
  })
})

describe("runWizard: the engine invariant (§3a.9.4)", () => {
  it("a state-changing verb while an agent is alive throws EngineInvariantError (negative); with no agent alive it goes through", async () => {
    const { run, agents, log } = await setup()
    const steps = fakeSteps(
      {
        settings: async (_ctx, deps) => {
          agents.alive = true
          await deps.bridge.provisionServerLaneEnv({ redeploy: "skip" })
          return { kind: "ok", status: "saved" }
        }
      },
      []
    )
    await expect(run(steps)).rejects.toBeInstanceOf(EngineInvariantError)
    expect(log.names("bridge")).not.toContain("bridge.provisionServerLaneEnv")

    const ok = await setup()
    const passing = fakeSteps(
      {
        settings: async (_ctx, deps) => {
          await deps.bridge.provisionServerLaneEnv({ redeploy: "skip" })
          return { kind: "ok", status: "saved" }
        }
      },
      []
    )
    await expect(ok.run(passing)).resolves.toMatchObject({ exitCode: 0 })
    expect(ok.log.names("bridge")).toContain("bridge.provisionServerLaneEnv")
  })

  it("the guard covers exactly the state-changing verbs and leaves reads alone", async () => {
    expect(bridgeMethodMapIsComplete()).toBe(true)
    const guardedVerbs = Object.entries(BRIDGE_METHOD_VERBS)
      .filter(([, verb]) => (STATE_CHANGING_VERBS as readonly string[]).includes(verb))
      .map(([, verb]) => verb)
      .sort()
    expect(guardedVerbs).toEqual([...STATE_CHANGING_VERBS].sort())
    const log = new CallLog()
    const agents = createFakeAgents(log)
    agents.alive = true
    const bridge = guardBridge(createFakeBridge(log), agents)
    await expect(bridge.keys()).resolves.toBeTruthy()
    for (const call of [
      () => bridge.claimProof("r", "tag"),
      () => bridge.ensureSiteSource({ productionHosts: [], consentMode: "required" }),
      () => bridge.markGa4KeyEvents({ runId: "r", names: [] }),
      () => bridge.declareConversions({ runId: "r", conversions: [] }),
      () => bridge.enableMetaRelay({ sourceRef: "s", enable: true }),
      () => bridge.removeServerLaneEnv(),
      () => bridge.disableSiteSource(),
      () => bridge.revokeLink("lk")
    ]) {
      expect(call).toThrow(EngineInvariantError)
    }
  })
})

describe("runWizard: capabilities, budgets, nested mode and the fence", () => {
  it("a step whose capability the app lacks fails INF_WIZ_BRIDGE_PROTOCOL without running (link checks its own)", async () => {
    const setupResult = await setup()
    const bridge = createFakeBridge(setupResult.log, { capabilities: ["tag.status.v1", "tag.link.v1", "tag.runs.v1"] })
    setupResult.deps.bridge = bridge
    const ran: WizardStepId[] = []
    const result = await setupResult.run(fakeSteps({}, ran))
    expect(ran).toEqual(["link", "agent"])
    expect(result).toMatchObject({ exitCode: 2, stoppedAt: "before", haltingCodes: ["INF_WIZ_BRIDGE_PROTOCOL"] })
  })

  it("a step that runs past its budget ends with the budget's outcome and kills the agents", async () => {
    const { run, log } = await setup()
    const result = await run(fakeSteps({ jobs: () => new Promise(() => {}) }, []), {
      budgets: { jobs: { ms: 10, onOverrun: { kind: "failed", code: "INF_WIZ_AGENT_TIMEOUT", message: "late", next: "halt" } } },
      settleMs: 20
    })
    expect(result).toMatchObject({ exitCode: 1, stoppedAt: "jobs" })
    expect(log.names("agents")).toContain("agents.killAll")
  })

  it("after an overrun the engine waits for the step to unwind, THEN restores the fence snapshot, before it returns (O1-04)", async () => {
    const { run, log } = await setup()
    const order: string[] = []
    const result = await run(
      fakeSteps(
        {
          jobs: (ctx) =>
            new Promise((resolve) => {
              ctx.signal.addEventListener("abort", () => {
                setTimeout(() => {
                  order.push("step cleaned up")
                  resolve({ kind: "ok", status: "late" })
                }, 15)
              })
            })
        },
        []
      ),
      {
        budgets: { jobs: { ms: 10, onOverrun: { kind: "failed", code: "INF_WIZ_AGENT_TIMEOUT", message: "late", next: "halt" } } },
        settleMs: 2_000,
        fenceAbort: async () => {
          order.push(`fence abort (killAll before: ${log.names("agents").includes("agents.killAll")})`)
        }
      }
    )
    order.push("engine returned")
    expect(result).toMatchObject({ exitCode: 1, stoppedAt: "jobs" })
    expect(order).toEqual(["step cleaned up", "fence abort (killAll before: true)", "engine returned"])
  })

  it("nested mode spawns no agent: runJobs throws inside a step, and the jobs step is replaced by the handoff", async () => {
    const { run, log } = await setup({ nested: true })
    let threw: unknown = null
    const handoffRan: string[] = []
    await run(
      fakeSteps(
        {
          agent: async (_ctx, deps) => {
            try {
              await deps.agents.runJobs({ items: [], brief: "", budget: { maxTurns: 1, wallMs: 1 }, onClaim() {}, onAsk() {}, onProgress() {}, onNarrate() {} })
            } catch (error) {
              threw = error
            }
            return { kind: "ok", status: "nested" }
          }
        },
        []
      ),
      { nestedJobs: async () => (handoffRan.push("handoff"), { kind: "parked", code: "INF_WIZ_NEEDS_ANSWERS", reason: "jobs handed off", resumeHint: "--resume" }) }
    )
    expect(threw).toBeInstanceOf(EngineInvariantError)
    expect(log.names("agents")).not.toContain("agents.runJobs")
    expect(handoffRan).toEqual(["handoff"])
  })

  it("the default after-step writes the gitignore fence after `before` is ok, not before it", async () => {
    const root = tempRoot()
    writeFileSync(join(root, ".gitignore"), "node_modules\n")
    const { ctx, deps } = await setup({ root })
    const seen: string[] = []
    const steps = fakeSteps(
      {
        before: async () => {
          seen.push(readFileSync(join(root, ".gitignore"), "utf8"))
          return { kind: "ok", status: "branch made" }
        },
        keys: async () => {
          seen.push(readFileSync(join(root, ".gitignore"), "utf8"))
          return { kind: "ok", status: "keys" }
        }
      },
      []
    )
    await runWizard(ctx, deps, { steps })
    expect(seen[0]).toBe("node_modules\n")
    expect(seen[1]).toBe(`node_modules\n${GITIGNORE_FENCE_BLOCK}\n`)
  })

  it("stops between steps when the run is aborted (exit 130)", async () => {
    const { run, controller } = await setup()
    const ran: WizardStepId[] = []
    const result = await run(fakeSteps({ keys: async () => (controller.abort(), { kind: "ok", status: "k" }) }, ran))
    expect(result).toMatchObject({ exitCode: 130, interrupted: true })
    expect(ran.at(-1)).toBe("keys")
  })
})
