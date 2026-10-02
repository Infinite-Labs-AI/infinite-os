// The `CheckRunner` (§3e.7; lane O6): one object every step reaches checks through. O6 implements the
// offline and build checks, the census and THE grader here; lane O9 registers the live (T1) checks, the
// setup checks, the env-targets check and the post-turn gate through `register(checkId, fn)` (wired at
// integration, I1, in `createDefaultWizardDeps`). Nothing here guesses: a check that is not registered
// throws `CheckNotRegisteredError` (a wiring bug must surface, never read as "fine"), and registering an
// id twice throws.
//
// THE SEAM CONTRACT for O9 (`CHECK_RUNNER_SEAMS`): each coarse CheckRunner method dispatches to one
// registered check id with one input object:
//   liveBytes    → "live_bytes"    {urls, expect}
//   redirectWalk → "redirect_walk" {urls}
//   csp          → "csp"           {url}
//   metaDomains  → "meta_domains"  {domains, pixelIds}
//   setupChecks  → "setup_checks"  {appRoot}
//   envTargets   → "env_targets"   {envSourcedIds, hosting}
//   turnGate     → "turn_gate"     {diff, connectionIds}
// Fine-grained ids the job table names (e.g. `posthog_config`, `csp_header`) are registered by O9 under
// their own names and reached through `run(checkId, input)`.
import type { WorkspaceInstallArtifacts } from "../types.js"
import type { TagHosting } from "../wizard/contracts/bridge.js"
import type {
  BuildResult,
  CensusResult,
  CheckContext,
  CheckFn,
  CheckId,
  CheckResult,
  CheckRunner,
  EnvSourcedId,
  T0Scenario,
  TurnDiff
} from "../wizard/contracts/jobs.js"
import type { TestExpect, TestMode, TestResult, TestTool } from "../wizard/contracts/test-engine.js"
import type { DenyReadSet, SandboxedSpawnFn } from "../t0/sandbox.js"
import { runT0Scenarios, T0_SCENARIO_IDS, type RunT0ScenariosOptions } from "../t0/scenarios.js"
import { gradeBuild, runBuild, type BuildRun } from "./build.js"
import { censusChecks, runCensus } from "./census.js"
import { gradeTestRunFull, type GradeContext } from "./grade-test-run.js"
import type { PackageManager } from "../types.js"

export const CHECK_RUNNER_SEAMS = {
  liveBytes: "live_bytes",
  redirectWalk: "redirect_walk",
  csp: "csp",
  metaDomains: "meta_domains",
  setupChecks: "setup_checks",
  envTargets: "env_targets",
  turnGate: "turn_gate"
} as const

/** The input object each seam id receives. */
export interface CheckRunnerSeamInputs {
  live_bytes: { urls: readonly string[]; expect: TestExpect }
  redirect_walk: { urls: readonly string[] }
  csp: { url: string }
  meta_domains: { domains: readonly string[]; pixelIds: readonly string[] }
  setup_checks: { appRoot: string }
  env_targets: { envSourcedIds: readonly EnvSourcedId[]; hosting: TagHosting }
  turn_gate: { diff: TurnDiff; connectionIds: readonly string[] }
}

/** The ids O6 registers itself (O9 must not reuse them). */
export const O6_CHECK_IDS = [
  "t0",
  ...T0_SCENARIO_IDS,
  "build",
  "build_baseline",
  "build_green_or_baseline",
  "census",
  "census_one_per_tool",
  "census_ga4_config_once",
  "census_posthog_init_once",
  "census_meta_init_once",
  "grade_test_run",
  "one_beacon_per_tool",
  "ga4_one_page_view",
  "meta_pixel_once",
  "posthog_via_proxy_once",
  "preview_self_silent",
  "no_csp_violation",
  "no_pii",
  "ga4_seen_leaving",
  "meta_seen_leaving",
  "meta_automatic_events"
] as const

export class CheckNotRegisteredError extends Error {
  constructor(readonly checkId: string) {
    super(`no check is registered under "${checkId}"`)
    this.name = "CheckNotRegisteredError"
  }
}

export interface CheckRunnerOptions {
  /** Absolute repo root. */
  root: string
  /** The app root, absolute or relative to `root`. */
  appRoot: string
  /** The cloud run id once the `agent` step created it (a getter: the runner exists before the run does). */
  runId?: () => string | null
  now?: () => Date
  /** Test seam / override: the sandboxed spawn the build and T0 use. */
  spawn?: SandboxedSpawnFn
  denyReads?: DenyReadSet
  packageManager?: PackageManager
  buildTimeoutMs?: number
  t0DeadlineMs?: number
  /** A baseline restored on resume (state.json). */
  baseline?: BuildResult | null
  /** Test seam: replaces the sandboxed T0 run. */
  t0Run?: RunT0ScenariosOptions["run"]
  platform?: NodeJS.Platform
  signal?: AbortSignal
}

/** The grader input `run("grade_test_run", …)` takes. */
export interface GradeTestRunInput {
  result: TestResult
  expect: TestExpect
  mode: TestMode
  ctx: Omit<GradeContext, "runId" | "now">
}

const GRADE_DERIVED_IDS = new Set([
  "one_beacon_per_tool",
  "ga4_one_page_view",
  "meta_pixel_once",
  "posthog_via_proxy_once",
  "preview_self_silent",
  "no_csp_violation",
  "no_pii",
  "ga4_seen_leaving",
  "meta_seen_leaving",
  "meta_automatic_events"
])

function asArray(value: CheckResult | CheckResult[]): CheckResult[] {
  return Array.isArray(value) ? value : [value]
}

export interface O6CheckRunner extends CheckRunner {
  /** The baseline taken in `before` (persist it in state.json; pass it back as `options.baseline` on resume). */
  baseline(): BuildResult | null
  /** Registered check ids (built-in and O9's). */
  registered(): string[]
}

export function createCheckRunner(options: CheckRunnerOptions): O6CheckRunner {
  const now = options.now ?? (() => new Date())
  const runId = options.runId ?? (() => null)
  const ctx = (): CheckContext => ({ runId: runId(), now, signal: options.signal })
  const registry = new Map<string, CheckFn>()
  let baseline: BuildResult | null = options.baseline ?? null

  const buildOptions = () => ({
    root: options.root,
    appRoot: options.appRoot,
    packageManager: options.packageManager,
    timeoutMs: options.buildTimeoutMs,
    signal: options.signal,
    spawn: options.spawn,
    denyReads: options.denyReads,
    platform: options.platform
  })

  const t0 = (scenarios: readonly T0Scenario[], artifacts: WorkspaceInstallArtifacts) =>
    runT0Scenarios(scenarios, artifacts, {
      runId: runId(),
      now,
      deadlineMs: options.t0DeadlineMs,
      spawn: options.spawn,
      denyReads: options.denyReads,
      signal: options.signal,
      platform: options.platform,
      ...(options.t0Run ? { run: options.t0Run } : {})
    })

  const grade = (input: GradeTestRunInput) => gradeTestRunFull(input.result, input.expect, input.mode, { ...input.ctx, runId: runId(), now })

  const builtIn = (checkId: string, fn: CheckFn) => {
    registry.set(checkId, fn)
  }

  builtIn("t0", async (input) => {
    const { scenarios, artifacts } = input as { scenarios: readonly T0Scenario[]; artifacts: WorkspaceInstallArtifacts }
    return t0(scenarios, artifacts)
  })
  for (const id of T0_SCENARIO_IDS) {
    builtIn(id, async (input) => {
      const { params, artifacts } = input as { params: Readonly<Record<string, unknown>>; artifacts: WorkspaceInstallArtifacts }
      return t0([{ id, checkId: id, params }], artifacts)
    })
  }
  const buildCheck = (checkId: string) => async () => gradeBuild(checkId, await runBuild(buildOptions()), baseline, ctx())
  builtIn("build", buildCheck("build"))
  builtIn("build_green_or_baseline", buildCheck("build_green_or_baseline"))
  builtIn("build_baseline", async () => {
    const run = await runBuild(buildOptions())
    baseline = run
    // The baseline is reported, never blamed: a red baseline is `info`, not a problem of this run.
    const graded = gradeBuild("build_baseline", run, null, ctx())
    return run.ok || graded.state === "undetermined" ? graded : { ...graded, state: "info", reason: `baseline_red — ${run.failureSignature.slice(0, 3).join("; ")}` }
  })
  const census = (input: unknown): CensusResult => {
    const given = (input ?? {}) as { census?: CensusResult; root?: string; appRoot?: string }
    return given.census ?? runCensus({ root: given.root ?? options.root, appRoot: given.appRoot ?? options.appRoot })
  }
  builtIn("census", async (input) => censusChecks(census(input), ctx()))
  for (const id of ["census_one_per_tool", "census_ga4_config_once", "census_posthog_init_once", "census_meta_init_once"]) {
    builtIn(id, async (input) => censusChecks(census(input), ctx()).filter((result) => result.checkId === id))
  }
  builtIn("grade_test_run", async (input) => {
    const graded = grade(input as GradeTestRunInput)
    return [...Object.values(graded.tools), ...(graded.metaAutomaticEvents ? [graded.metaAutomaticEvents.result] : []), ...graded.checks]
  })
  for (const id of GRADE_DERIVED_IDS) {
    builtIn(id, async (input) => {
      const graded = grade(input as GradeTestRunInput)
      if (id === "meta_automatic_events") return graded.metaAutomaticEvents ? [graded.metaAutomaticEvents.result] : []
      return graded.checks.filter((result) => result.checkId === id)
    })
  }

  const run = async (checkId: CheckId, input: unknown): Promise<CheckResult | CheckResult[]> => {
    const fn = registry.get(checkId)
    if (!fn) throw new CheckNotRegisteredError(checkId)
    return fn(input, ctx())
  }
  const seam = async <K extends keyof CheckRunnerSeamInputs>(id: K, input: CheckRunnerSeamInputs[K]): Promise<CheckResult[]> => asArray(await run(id, input))

  return {
    run,
    register(checkId, fn) {
      if (registry.has(checkId)) throw new Error(`a check is already registered under "${checkId}"`)
      registry.set(checkId, fn)
    },
    registered: () => [...registry.keys()].sort(),
    baseline: () => baseline,
    async buildBaseline() {
      const result = await runBuild(buildOptions())
      baseline = result
      return result
    },
    async build(): Promise<BuildRun> {
      return runBuild(buildOptions())
    },
    t0,
    liveBytes: (urls, expect) => seam("live_bytes", { urls, expect }),
    redirectWalk: (urls) => seam("redirect_walk", { urls }),
    csp: (url) => seam("csp", { url }),
    metaDomains: (domains, pixelIds) => seam("meta_domains", { domains, pixelIds }),
    async census(root, appRoot) {
      return runCensus({ root, appRoot })
    },
    setupChecks: (appRoot) => seam("setup_checks", { appRoot }),
    envTargets: (envSourcedIds, hosting) => seam("env_targets", { envSourcedIds, hosting }),
    turnGate: (diff, gateCtx) => seam("turn_gate", { diff, connectionIds: gateCtx.connectionIds }),
    async gradeTestRun(result, expect, mode, gradeCtx) {
      return grade({ result, expect, mode, ctx: gradeCtx }).tools as Record<TestTool, CheckResult>
    }
  }
}
