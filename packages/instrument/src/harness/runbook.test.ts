import { describe, expect, it } from "vitest"

import { HARNESS_STEPS, HARNESS_STEPS_BY_ID } from "./run.js"
import { createHarnessReport } from "./state.js"
import {
  RUNBOOK_STEP_IDS,
  runRunbook,
  type RunbookStep
} from "./runbook.js"
import { HARNESS_FAILURE_CODES, type HarnessReport } from "./types.js"

interface Ctx {
  report: HarnessReport
  log: string[]
}

function ctx(): Ctx {
  return { report: createHarnessReport({ mode: "apply", root: "/tmp/site" }), log: [] }
}

function step(
  id: string,
  ok: boolean,
  next: "halt" | "continue",
  code: (typeof HARNESS_FAILURE_CODES)[number] = "INF_PLAN_BLOCKED"
): RunbookStep<Ctx> {
  return {
    id,
    title: id,
    run: (context) => {
      context.log.push(`run:${id}`)
    },
    successCheck: () => ok,
    failure: { code, message: () => `${id} failed`, next }
  }
}

describe("runRunbook", () => {
  // ONE SOURCE OF TRUTH. The report's step list and the steps the harness actually runs must be the
  // same ids in the same order; this list once said 12 while the harness ran 13.
  it("the harness runs exactly RUNBOOK_STEP_IDS, in order, and every step carries its own id", () => {
    expect(HARNESS_STEPS.map((step) => step.id)).toEqual([...RUNBOOK_STEP_IDS])
    expect(HARNESS_STEPS).toHaveLength(RUNBOOK_STEP_IDS.length)
    for (const [key, step] of Object.entries(HARNESS_STEPS_BY_ID)) expect(step.id, key).toBe(key)
    expect(Object.keys(HARNESS_STEPS_BY_ID).sort()).toEqual([...RUNBOOK_STEP_IDS].sort())
  })

  it("halts on a halting failure, marks the rest not_run, and still finalizes with all seven providers", async () => {
    const context = ctx()
    const finalized: string[] = []
    const result = await runRunbook(
      [step("a", true, "halt"), step("b", false, "halt", "INF_ENV_DIRTY_TREE"), step("c", true, "halt")],
      context,
      {
        finalize: (report) => {
          finalized.push(...report.providers.map((p) => p.provider))
        }
      }
    )
    expect(context.log).toEqual(["run:a", "run:b"])
    expect(result.halted).toBe(true)
    expect(context.report.failure).toEqual({
      step: "b",
      code: "INF_ENV_DIRTY_TREE",
      message: "b failed",
      next: "halt"
    })
    expect(context.report.steps.map((s) => s.status)).toEqual(["ok", "failed", "not_run"])
    expect(finalized).toHaveLength(7)
    expect(context.report.finishedAt).not.toBeNull()
  })

  it("treats a thrown error as that step's failure with its message", async () => {
    const context = ctx()
    const throwing: RunbookStep<Ctx> = {
      ...step("apply", true, "halt", "INF_APPLY_ROLLED_BACK"),
      run: () => {
        throw new Error("disk full")
      }
    }
    const result = await runRunbook([throwing, step("z", true, "halt")], context, {
      finalize: () => undefined
    })
    expect(result.halted).toBe(true)
    expect(context.report.failure).toMatchObject({
      code: "INF_APPLY_ROLLED_BACK",
      message: expect.stringContaining("disk full")
    })
  })
})
