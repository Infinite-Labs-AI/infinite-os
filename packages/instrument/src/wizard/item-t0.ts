// The offline (T0) checks of one checklist item, as the `jobs` step (O3) and the review's fix rounds (O4)
// run them (I1b). Two integration gaps the offline end-to-end run exposed are closed here, once:
//
// 1. Lane O6's scenarios need the run's facts (`host_matrix`, `fbc_capture`, `click_test`,
//    `one_runtime_per_page` all require `params.productionHost`; the guard's exempt hosts come from the
//    plan). The callers used to send only the item's own fields, so `planScenario` threw and the whole
//    step crashed the moment an agent claimed a preview-guard job. The params now carry the production
//    host `before` measured and the exempt hosts the approved plan's guard uses (§3h.9).
// 2. A scenario that still cannot be built for this item (a parameter the wizard does not have, e.g. a
//    click spec for a framework whose clicks are the rehearsal's) is UNDETERMINED for that item, never a
//    crash and never a pass: the state machine keeps the item `claimed`. Each scenario runs on its own,
//    so one unbuildable scenario never turns its siblings' real verdicts into errors.
import { join } from "node:path"

import type { WizardContext, WizardDeps } from "./contracts/deps.js"
import type { ChecklistItem, CheckResult, JobCheckSpec, T0Scenario } from "./contracts/jobs.js"
import { readBeforeFactsFile } from "./handoff/before-facts.js"
import { loadPlanApprovals } from "../install/step-inputs.js"
import { pageSourceFromFiles } from "../t0/inline-scripts.js"
import type { T0PageSource } from "../t0/protocol.js"

/** The reason a T0 scenario the wizard cannot build for an item carries (undetermined). */
export const T0_UNBUILDABLE_PREFIX = "test_error — the offline test could not be set up for this job"

/** The run-level params every scenario of every item gets: the production host and the guard's exempt hosts. */
export async function t0RunParams(ctx: Pick<WizardContext, "root" | "runId" | "state">, deps: Pick<WizardDeps, "fs">): Promise<Record<string, unknown>> {
  const runId = ctx.runId ?? ctx.state.get().runId
  const before = await readBeforeFactsFile(deps.fs, ctx.root, runId)
  const saved = await loadPlanApprovals(ctx as WizardContext, deps as WizardDeps)
  const productionHost = before?.productionHost ?? null
  const exempt = saved?.guard && saved.guard.emit ? saved.guard.exempt : []
  return { ...(productionHost ? { productionHost } : {}), ...(exempt.length > 0 ? { exempt: [...exempt] } : {}) }
}

const GUARDED_TARGETS: ReadonlySet<string> = new Set(["ga4", "posthog", "meta"])
/**
 * R4-2: jobs on an ADOPTED tool whose offline test must load the site's own page as the agent left it (the job's files'
 * inline scripts), never the managed page built from Infinite's keys (run 4: Meta not connected → a managed page with no
 * capture → "wrote no _fbc cookie" while production, running the agent's code, wrote it).
 */
const ADOPTED_PAGE_JOBS: ReadonlySet<string> = new Set(["meta_improve"])

/** The page the adopted job's files put on the browser, or why it cannot be known without running them. */
async function adoptedPage(item: ChecklistItem, io: { fs: Pick<WizardDeps["fs"], "readText">; root: string }): Promise<{ source: T0PageSource } | { sourceError: string }> {
  const files: Array<{ file: string; source: string }> = []
  for (const file of item.allow.files) {
    const source = await io.fs.readText(join(io.root, file))
    if (source === null) return { sourceError: `${file} is unreadable` }
    files.push({ file, source })
  }
  const built = pageSourceFromFiles(files)
  return built.ok ? { source: built.source } : { sourceError: built.reason }
}

/**
 * One T0 scenario per spec: the item's own fields plus the run-level params. A preview-guard job (7) on an
 * HTML page is tested on THAT page as the agent left it (`source`), for the one tool it guards (`tools`);
 * otherwise O6 would load the managed page and grade the wrong bytes.
 */
export async function itemT0Scenarios(
  item: ChecklistItem,
  specs: readonly Pick<JobCheckSpec, "checkId">[],
  runParams: Readonly<Record<string, unknown>>,
  io: { fs: Pick<WizardDeps["fs"], "readText">; root: string }
): Promise<T0Scenario[]> {
  const target = item.id.slice(item.id.indexOf(":") + 1)
  const page = item.allow.files.find((file) => /\.html?$/i.test(file))
  const html = item.jobId === "preview_guard" && page ? await io.fs.readText(join(io.root, page)) : null
  const adopted = ADOPTED_PAGE_JOBS.has(item.jobId) && specs.length > 0 ? await adoptedPage(item, io) : null
  return specs.map((spec) => ({
    id: `${item.id}:${spec.checkId}`,
    checkId: spec.checkId,
    params: {
      ...runParams,
      itemId: item.id,
      jobId: item.jobId,
      target,
      files: [...item.allow.files],
      ...(spec.checkId === "host_matrix" && html !== null ? { source: { html }, ...(GUARDED_TARGETS.has(target) ? { tools: [target] } : {}) } : {}),
      ...(adopted ?? {})
    }
  }))
}

/** A scenario lane O6 refused to build (`T0ScenarioError`) or a malformed check input (`CheckInputError`). */
function isUnbuildable(error: unknown): error is Error {
  return error instanceof Error && (error.name === "T0ScenarioError" || error.name === "CheckInputError")
}

/**
 * Runs each scenario through `checks.t0` on its own. An unbuildable scenario → `undetermined` with the
 * reason; any other failure (a crash of the runner itself) still throws.
 */
export async function runItemT0(
  deps: Pick<WizardDeps, "checks">,
  scenarios: readonly T0Scenario[],
  artifacts: Parameters<WizardDeps["checks"]["t0"]>[1],
  meta: { runId: string | null; at: () => string }
): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  for (const scenario of scenarios) {
    try {
      out.push(...(await deps.checks.t0([scenario], artifacts)))
    } catch (error) {
      if (!isUnbuildable(error)) throw error
      out.push({ checkId: scenario.checkId, tier: "T0", state: "undetermined", reason: `${T0_UNBUILDABLE_PREFIX} (${error.message.slice(0, 160)})`, at: meta.at(), runId: meta.runId })
    }
  }
  return out
}
