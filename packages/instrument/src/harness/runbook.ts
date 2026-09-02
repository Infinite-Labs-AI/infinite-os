// The runbook runner: teardown §5.2's eleven steps as an ordered list, each naming its own
// failure code and what happens next (halt, or continue degraded and note it). The runner is
// generic over the context so tests can drive it with fakes; run.ts supplies the real steps.
import type { FailureNext, HarnessFailure, HarnessFailureCode, HarnessReport, StepOutcome } from "./types.js"

/** Teardown §5.2, in order. Also the ids the report's step list uses. */
export const RUNBOOK_STEP_IDS = [
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
] as const
export type RunbookStepId = (typeof RUNBOOK_STEP_IDS)[number]

/** A step may return nothing (ran), or ask to be recorded as skipped with a one-line reason. */
export type StepRunResult = void | { skipped: string } | { note: string }

export interface RunbookStep<Ctx extends { report: HarnessReport }> {
  id: string
  title: string
  run(ctx: Ctx): Promise<StepRunResult> | StepRunResult
  /** Evaluated after `run` unless the step skipped itself. False → the step's failure fires. */
  successCheck(ctx: Ctx): Promise<boolean> | boolean
  failure: {
    code: HarnessFailureCode
    /** Built after the fact so the message can quote what the step saw. */
    message: (ctx: Ctx, error?: unknown) => string
    next: FailureNext
  }
}

export interface RunRunbookOptions<Ctx extends { report: HarnessReport }> {
  /** Always called last — halted or not — with the finished report (prints all seven rows). */
  finalize: (report: HarnessReport, ctx: Ctx) => Promise<void> | void
  /** Test seam. */
  now?: () => string
}

export interface RunRunbookResult {
  halted: boolean
  report: HarnessReport
}

function recordFailure(report: HarnessReport, failure: HarnessFailure): void {
  report.failures.push(failure)
  // Headline rule: the first HALT wins; otherwise the first continuing failure.
  if (report.failure === null || (report.failure.next === "continue" && failure.next === "halt")) {
    report.failure = failure
  }
}

export async function runRunbook<Ctx extends { report: HarnessReport }>(
  steps: ReadonlyArray<RunbookStep<Ctx>>,
  ctx: Ctx,
  options: RunRunbookOptions<Ctx>
): Promise<RunRunbookResult> {
  const now = options.now ?? (() => new Date().toISOString())
  const report = ctx.report
  let halted = false

  for (const step of steps) {
    const outcome: StepOutcome = { id: step.id, title: step.title, status: "not_run" }
    report.steps.push(outcome)
    if (halted) {
      continue
    }

    let error: unknown
    let result: StepRunResult
    try {
      result = await step.run(ctx)
    } catch (thrown) {
      error = thrown
      result = undefined
    }

    if (result && "skipped" in result) {
      outcome.status = "skipped"
      outcome.note = result.skipped
      continue
    }
    if (result && "note" in result) {
      outcome.note = result.note
    }

    let ok = false
    if (error === undefined) {
      try {
        ok = await step.successCheck(ctx)
      } catch (thrown) {
        error = thrown
      }
    }

    if (ok) {
      outcome.status = "ok"
      continue
    }

    // A thrown error is quoted in the failure message unless the builder already did.
    let message = step.failure.message(ctx, error)
    if (error !== undefined) {
      const text = errorText(error)
      if (text && !message.includes(text)) {
        message = `${message} (${text})`
      }
    }
    const failure: HarnessFailure = {
      step: step.id,
      code: step.failure.code,
      message,
      next: step.failure.next
    }
    outcome.status = "failed"
    outcome.failure = failure
    recordFailure(report, failure)
    if (failure.next === "halt") {
      halted = true
    }
  }

  report.finishedAt = now()
  await options.finalize(report, ctx)
  return { halted, report }
}

/** `Error.message`, or the string form, for quoting in a failure message. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
