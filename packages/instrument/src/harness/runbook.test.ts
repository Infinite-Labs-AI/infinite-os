import { describe, expect, it } from "vitest"

import { createHarnessReport, findProvider } from "./state.js"
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
  it("names the eleven teardown steps in order", () => {
    expect(RUNBOOK_STEP_IDS).toEqual([
      "preflight",
      "inspect",
      "resolve-keys",
      "classify",
      "plan",
      "confirm",
      "apply",
      "conversions",
      "server-lane",
      "verify",
      "report"
    ])
  })

  it("carries every teardown failure code", () => {
    for (const code of [
      "INF_ENV_DIRTY_TREE",
      "INF_DETECT_NO_FRAMEWORK",
      "INF_POSTHOG_NO_KEY",
      "INF_PLAN_UNMANAGED_TARGET",
      "INF_APPLY_ROLLED_BACK",
      "INF_MARK_STALE_ELEMENT",
      "INF_VERIFY_NO_RECEIPT",
      "INF_ARGS_CONVERSIONS_REQUIRED"
    ]) {
      expect(HARNESS_FAILURE_CODES).toContain(code)
    }
  })

  it("runs steps in order and records ok outcomes", async () => {
    const context = ctx()
    const result = await runRunbook([step("a", true, "halt"), step("b", true, "halt")], context, {
      finalize: () => undefined
    })
    expect(context.log).toEqual(["run:a", "run:b"])
    expect(result.halted).toBe(false)
    expect(context.report.steps.map((s) => [s.id, s.status])).toEqual([
      ["a", "ok"],
      ["b", "ok"]
    ])
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

  it("continues past a continuing failure and keeps it as the report failure when nothing halts", async () => {
    const context = ctx()
    const result = await runRunbook(
      [step("a", false, "continue", "INF_POSTHOG_NO_KEY"), step("b", true, "halt")],
      context,
      { finalize: () => undefined }
    )
    expect(context.log).toEqual(["run:a", "run:b"])
    expect(result.halted).toBe(false)
    expect(context.report.failure?.code).toBe("INF_POSTHOG_NO_KEY")
    expect(context.report.failures).toHaveLength(1)
  })

  it("a later halting failure outranks an earlier continuing one as the headline", async () => {
    const context = ctx()
    await runRunbook(
      [
        step("a", false, "continue", "INF_POSTHOG_NO_KEY"),
        step("b", false, "halt", "INF_APPLY_ROLLED_BACK")
      ],
      context,
      { finalize: () => undefined }
    )
    expect(context.report.failure?.code).toBe("INF_APPLY_ROLLED_BACK")
    expect(context.report.failures.map((f) => f.code)).toEqual([
      "INF_POSTHOG_NO_KEY",
      "INF_APPLY_ROLLED_BACK"
    ])
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

  it("lets a step skip itself and still prints all seven rows unchanged", async () => {
    const context = ctx()
    const skipping: RunbookStep<Ctx> = {
      ...step("server-lane", true, "continue"),
      run: () => ({ skipped: "no --server-lane" })
    }
    await runRunbook([skipping], context, { finalize: () => undefined })
    expect(context.report.steps[0]).toMatchObject({ status: "skipped", note: "no --server-lane" })
    expect(context.report.providers).toHaveLength(7)
    expect(findProvider(context.report, "server_lane").state).toBe("absent")
  })
})
