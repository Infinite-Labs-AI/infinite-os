// Step 2 `before`: "Check the live site" (lane O8; §3d.1 step 2).
//
// Branches from production FIRST, so nothing the wizard later writes lands on the user's branch and
// the scan reads what is live. Then: read the keys SILENTLY (connection IDs only, for `expect`: no ask,
// no plan lines; the `keys` step compares and asks later), build the baseline, scan + census + setup
// checks, ONE `dry_live` of the production root and up to 4 pages (no clicks, no fake click id: those
// happen only in the rehearsal and on the preview's own URL, R2-06), the T1 live checks, the cloud's
// baseline reads, the Before facts, and finally the checklist CANDIDATES (`seedCandidates`).
//
// Honesty rules this step keeps:
// - `expect` ids come from the keys verb only, never from the repo or a `.env` (R2-16);
// - nothing is graded here: the desktop returns facts, `checks.gradeTestRun` (lane O6) grades them;
// - no report cell is written here: the facts go to `.infinite/wizard/before.json` for the report
//   builder (lane O1), and the step status only COUNTS the wizard's own check states;
// - an undetermined check (held by consent, bot rules, a test error) is never counted as a problem.
//
// Call order (asserted by `before.test.ts`): hosting (the base is `hosting.vercel.productionBranch`,
// §3g.1) → branch → keys → baseline build → scan + census + setup checks → dry_live → T1 → baseline
// reads → Before facts → seedCandidates. The branch is created before any other verb and before any
// repo read.
import { createHash } from "node:crypto"
import { join } from "node:path"

import { scanForJobs, jobScanFrom, type JobScan } from "../../jobs/detectors/index.js"
import { detectDuplicates } from "../../jobs/detectors/duplicates.js"
import { detectAdoptedPosthogConfig } from "../../jobs/detectors/adopted-tags.js"
import type { RepoSnapshot } from "../../jobs/repo-files.js"
import { BRIDGE_ERROR_CODES, type BridgeErrorCode, type TagHosting, type TagKeys } from "../contracts/bridge.js"
import type { WizardCode } from "../contracts/codes.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { normalizeHost } from "../contracts/host-deny.js"
import type { BeforeFacts, BuildResult, CheckResult, ScanResult } from "../contracts/jobs.js"
import type { BaselineResponseFields } from "../contracts/report.js"
import type { BaseSource } from "../contracts/state.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { wizardBranchName } from "../contracts/git-host.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import {
  TEST_LIMITS,
  testExpectFromKeys,
  testRequestModeErrors,
  type TestExpect,
  type TestResult,
  type TestRunRequest,
  type TestTool
} from "../contracts/test-engine.js"

// ---------------------------------------------------------------------------------------------
// The Before facts handed to the report builder
// ---------------------------------------------------------------------------------------------

export const BEFORE_FACTS_SCHEMA = "infinite-tag.before-facts.v1" as const
/** Gitignored (inside `.infinite/wizard/`), mode 0600. Public IDs and facts only: never a secret. */
export const BEFORE_FACTS_PATH = `${WIZARD_PATHS.dir}/before.json` as const

/**
 * Everything `before` measured, as typed FACTS for the `live_today` column (lane O1's builder computes
 * the cells from them under FINISH_LINE_SOURCES; this step writes no cell).
 */
export interface BeforeFactsFile {
  schema: typeof BEFORE_FACTS_SCHEMA
  runId: string
  measuredAt: string
  productionHost: string | null
  scan: { framework: string; packageManager: string | null; appRoot: string; fileCount: number; truncated: boolean }
  facts: BeforeFacts
  /** `checks.gradeTestRun` of the dry load, per tool (null when no dry load ran). */
  grades: Partial<Record<TestTool, CheckResult>> | null
  /** The checks by moment, so the builder can map each to its FINISH_LINE_SOURCES input. */
  setupChecks: CheckResult[]
  envTargetChecks: CheckResult[]
  liveChecks: CheckResult[]
  baselineBuild: BuildResult
  /** The cloud's baseline reads (null parts stay null; never 0). */
  baseline: BaselineResponseFields | null
  /** The static CMP detector's answer (the grader's `cmpDetected` input when the window saw none). */
  cmpDetected: TestResult["environment"]["cmpDetected"]
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const TOOL_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta pixel" }
const SPA_FRAMEWORKS: ReadonlySet<string> = new Set(["next-app-router", "next-pages-router", "vite-react"])
/** `.gitignore` and the wizard's own `.infinite/` are exempt from the clean-tree check (`ios:…/harness/run.ts:197`). */
const CLEAN_TREE_EXEMPT = (path: string): boolean => path === ".gitignore" || path === ".infinite" || path.startsWith(".infinite/")

/** The bridge error code of a thrown bridge error (lane O2's `BridgeError {status, code, retryable}`), else null. */
export function bridgeErrorCode(error: unknown): BridgeErrorCode | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && (BRIDGE_ERROR_CODES as readonly string[]).includes(code) ? (code as BridgeErrorCode) : null
}

/** Bridge errors that stop the run because the Infinite app cannot serve it (exit 4). */
function appBlockedOutcome(error: unknown): StepOutcome | null {
  const code = bridgeErrorCode(error)
  const map: Partial<Record<BridgeErrorCode, WizardCode>> = {
    subscription_required: "INF_WIZ_SUBSCRIPTION_REQUIRED",
    signed_out: "INF_WIZ_SIGNED_OUT",
    unauthorized: "INF_WIZ_SIGNED_OUT"
  }
  const wizardCode = code ? map[code] : undefined
  if (!wizardCode) return null
  return {
    kind: "blocked",
    code: wizardCode,
    reason: wizardCode === "INF_WIZ_SUBSCRIPTION_REQUIRED" ? "Infinite needs an active subscription for this site" : "Sign in to the Infinite app, then run npx infinite-tag again"
  }
}

function withoutEnvelope<T extends { protocolVersion: 1; requestId: string }>(response: T): Omit<T, "protocolVersion" | "requestId"> {
  const { protocolVersion: _version, requestId: _request, ...rest } = response
  return rest
}

/** Reads `origin/HEAD` (what `git symbolic-ref refs/remotes/origin/HEAD` prints), worktree-aware. */
export async function readOriginHead(deps: Pick<WizardDeps, "fs">, root: string): Promise<string | null> {
  const read = async (path: string): Promise<string | null> => {
    try {
      return await deps.fs.readText(path)
    } catch {
      // `.git` is usually a directory: reading it as a file is "not a worktree pointer".
      return null
    }
  }
  let gitDir = join(root, ".git")
  const dotGit = await read(gitDir)
  if (dotGit !== null && dotGit.startsWith("gitdir:")) {
    // A worktree: `.git` is a file; the remote refs live in the common dir.
    const worktreeGitDir = dotGit.slice("gitdir:".length).trim()
    const commonDir = (await read(join(worktreeGitDir, "commondir")))?.trim()
    gitDir = commonDir ? (commonDir.startsWith("/") ? commonDir : join(worktreeGitDir, commonDir)) : worktreeGitDir
  }
  const head = await read(join(gitDir, "refs", "remotes", "origin", "HEAD"))
  const match = head ? /^ref:\s*refs\/remotes\/origin\/(.+?)\s*$/.exec(head) : null
  return match ? match[1]! : null
}

/** §3g.1 base: Vercel's production branch, else the GitHub default branch, else origin/HEAD. */
export async function resolveBase(
  deps: Pick<WizardDeps, "host" | "fs">,
  hosting: TagHosting,
  root: string
): Promise<{ base: string; baseSource: BaseSource } | null> {
  if (hosting.provider === "vercel" && hosting.vercel?.productionBranch) return { base: hosting.vercel.productionBranch, baseSource: "vercel" }
  const facts = await deps.host.repoFacts()
  if (!("unsupported" in facts) && facts.defaultBranch) return { base: facts.defaultBranch, baseSource: "default_branch" }
  const originHead = await readOriginHead(deps, root)
  return originHead ? { base: originHead, baseSource: "origin_head" } : null
}

/** The production host the dry load visits: the site source's first host, else Vercel's first domain. */
export function productionHostOf(keys: TagKeys, hosting: TagHosting): string | null {
  const host = keys.infinite.productionHosts[0] ?? hosting.vercel?.productionDomains[0] ?? null
  return host ? normalizeHost(host) : null
}

/**
 * The `dry_live` request for the production site: the root + up to 4 pages, `expect` from the keys, the
 * test-window consent seed on consent-required sites, an SPA navigation where the app has a second page.
 * NEVER `clicks` and NEVER `fakeClickId` (production: R2-06).
 */
export function beforeDryLiveRequest(input: {
  requestId: string
  runId: string
  productionHost: string
  pages: readonly string[]
  framework: string
  keys: TagKeys
  expect: TestExpect
}): TestRunRequest {
  const origin = `https://${input.productionHost}`
  const pages = input.pages.filter((page) => page !== "/").slice(0, TEST_LIMITS.maxTargets - 1)
  const targets = [{ url: `${origin}/`, label: "home" }, ...pages.map((page) => ({ url: `${origin}${page}`, label: page.slice(1).replace(/[^A-Za-z0-9]+/g, "_") || "page" }))]
  const consentRequired = input.keys.infinite.consentMode === "required" && input.keys.infinite.consentStorageKey !== null
  const request: TestRunRequest = {
    protocolVersion: 1,
    requestId: input.requestId,
    mode: "dry_live",
    runId: input.runId,
    productionHost: input.productionHost,
    targets,
    expect: input.expect,
    consentSeed: consentRequired ? { kind: "infinite_runtime_grant", storageKey: input.keys.infinite.consentStorageKey! } : null,
    deadlineMs: TEST_LIMITS.deadlineMs.dry_live
  }
  if (SPA_FRAMEWORKS.has(input.framework) && pages[0]) request.spaNavigation = { path: pages[0] }
  return request
}

function summarize(checks: readonly CheckResult[]): { pass: number; problem: number; unknown: number } {
  return {
    pass: checks.filter((check) => check.state === "pass").length,
    problem: checks.filter((check) => check.state === "problem").length,
    unknown: checks.filter((check) => check.state === "undetermined").length
  }
}

function syntheticCheck(checkId: string, state: CheckResult["state"], reason: string, at: string, runId: string): CheckResult {
  return { checkId, tier: "T1", state, reason, at, runId }
}

async function runDryLive(
  ctx: WizardContext,
  deps: WizardDeps,
  request: TestRunRequest
): Promise<{ result: TestResult | null; error: string | null }> {
  const { requestId: _ignored, protocolVersion: _version, ...body } = request
  const started = await deps.bridge.startTest(body, { signal: ctx.signal })
  const deadline = deps.clock.now().getTime() + request.deadlineMs + 30_000
  try {
    for (;;) {
      const poll = await deps.bridge.pollTest(started.testRunId, 25, { signal: ctx.signal })
      if (poll.state === "done") {
        if (!poll.result) return { result: null, error: "the test finished without a result" }
        return { result: poll.result, error: null }
      }
      if (poll.state === "failed" || poll.state === "cancelled") return { result: null, error: poll.error?.message ?? `the test ${poll.state}` }
      if (deps.clock.now().getTime() > deadline) {
        await deps.bridge.cancelTest(started.testRunId)
        return { result: null, error: "the test passed its deadline" }
      }
    }
  } catch (error) {
    if (ctx.signal.aborted) await deps.bridge.cancelTest(started.testRunId).catch(() => undefined)
    throw error
  }
}

// ---------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------

export interface BeforeStepOptions {
  /**
   * Builds the JobScan the registry seeds from (the repo snapshot + static detections). Defaults to
   * reading the tree (bounded, read-only); tests inject an in-memory snapshot.
   */
  jobScan?: (scan: ScanResult) => JobScan
  /** A fresh request id per bridge request body (defaults to crypto's randomUUID). */
  requestId?: () => string
}

/**
 * `inputHash`: the step's declared inputs are the run (which pins the link and the workspace) and the
 * roots; a new run or another site re-runs `before`. It reads the context's plain fields only.
 */
export function beforeInputHash(ctx: WizardContext): string {
  const input = JSON.stringify({ step: "before", runId: ctx.runId ?? null, root: ctx.root ?? null, appRoot: ctx.appRoot ?? null })
  return `sha256:${createHash("sha256").update(input).digest("hex")}`
}

export function createBeforeStep(options: BeforeStepOptions = {}): WizardStep<"before"> {
  const meta = WIZARD_STEP_META.before
  const buildJobScan = options.jobScan ?? scanForJobs
  const newRequestId = options.requestId ?? (() => globalThis.crypto.randomUUID())

  return {
    id: "before",
    title: meta.title,
    who: [...meta.who],
    learn: meta.learn,
    requiredCapabilities: [...meta.requiredCapabilities],
    inputHash: beforeInputHash,
    async run(ctx, deps): Promise<StepOutcome> {
      const sub = (text: string, tone: "ok" | "warn" | "info" | "pending" = "info") => ctx.emit.emit("step.sub", { step: "before", text: text.slice(0, 120), tone })
      const at = () => deps.clock.now().toISOString()

      // ---- preconditions ----
      if (!(await deps.git.isRepo())) {
        return { kind: "failed", code: "INF_WIZ_NO_GIT", message: "This folder is not a git repository. Run npx infinite-tag in your website's repo.", next: "halt" }
      }
      const tree = await deps.git.cleanTree()
      const dirty = tree.dirtyPaths.filter((path) => !CLEAN_TREE_EXEMPT(path))
      if (!tree.clean && dirty.length > 0) {
        const shown = dirty.slice(0, 5).join(", ")
        return {
          kind: "failed",
          code: "INF_WIZ_DIRTY_TREE",
          message: `Commit or stash your changes first (${shown}${dirty.length > 5 ? `, +${dirty.length - 5} more` : ""}); the wizard works on its own branch.`,
          next: "halt"
        }
      }
      const runId = ctx.runId
      if (runId === null) {
        return { kind: "failed", code: "INF_WIZ_BRANCH_FAILED", message: "No run id: the agent step did not start the run, so the branch cannot be named.", next: "halt" }
      }

      try {
        // ---- hosting (read-only; the base is the production branch) → branch ----
        const hosting: TagHosting = withoutEnvelope(await deps.bridge.hosting(undefined, { signal: ctx.signal }))
        const existing = ctx.state.get().git
        if (existing?.branch) {
          sub(`On branch ${existing.branch} (from ${existing.base})`, "ok")
        } else {
          const base = await resolveBase(deps, hosting, ctx.root)
          if (!base) {
            return { kind: "failed", code: "INF_WIZ_BRANCH_FAILED", message: "Could not tell which branch is production (no Vercel project, no default branch, no origin/HEAD).", next: "halt" }
          }
          const branch = wizardBranchName(ctx.now(), runId)
          let baseSha: string
          try {
            ;({ baseSha } = await deps.git.createBranch(base.base, branch))
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { kind: "failed", code: "INF_WIZ_BRANCH_FAILED", message: `Could not branch ${branch} from origin/${base.base}: ${message}`, next: "halt" }
          }
          ctx.state.update((state) => {
            state.git = { base: base.base, baseSource: base.baseSource, branch, baseSha, headSha: null }
          })
          await ctx.state.save()
          sub(`Branch ${branch} from ${base.base}${base.baseSource === "vercel" ? "" : " (fallback)"}`, "ok")
        }

        // ---- keys, silently (connection IDs only; `expect` never comes from the repo) ----
        const keys: TagKeys = withoutEnvelope(await deps.bridge.keys({ signal: ctx.signal }))
        const expect = testExpectFromKeys(keys)

        // ---- baseline build, scan, census, setup checks ----
        const baselineBuild = await deps.checks.buildBaseline()
        if (!baselineBuild.ok) sub("! Your build already fails on production; the wizard reports it and only fixes new failures", "warn")
        const scan = await deps.installer.scan({ root: ctx.root, appRoot: ctx.appRoot, hosting })
        sub(`Scanning ${scan.fileCount} files…`, "pending")
        if (scan.truncated) sub(`! The scan stopped at ${scan.fileCount} files; some code was not read`, "warn")
        const census = await deps.checks.census(ctx.root, scan.appRoot)
        const appRootAbsolute = scan.appRoot === "." ? ctx.root : join(ctx.root, scan.appRoot)
        const setupChecks = await deps.checks.setupChecks(appRootAbsolute)
        const jobScan = buildJobScan(scan)
        for (const tool of ["ga4", "posthog", "meta"] as const) {
          const found = census.entries.find((entry) => entry.tool === tool && entry.owner === "adopted")
          if (found) sub(`Found ${TOOL_LABEL[tool]} in ${found.file}:${found.line}`, "info")
        }
        let envTargetChecks: CheckResult[] = []
        if (census.envSourcedIds.length > 0 && hosting.provider === "vercel") {
          const envNames = [...new Set(census.envSourcedIds.map((entry) => entry.envName))].sort()
          const withTargets: TagHosting = withoutEnvelope(await deps.bridge.hosting(envNames, { signal: ctx.signal }))
          envTargetChecks = await deps.checks.envTargets(census.envSourcedIds, withTargets)
        }

        // ---- dry_live of production (nothing sent; no clicks, no fake click id) ----
        const productionHost = productionHostOf(keys, hosting)
        const cmpDetectedStatic = jobScan.detections.cmp.cmp
        let dryLive: TestResult | null = null
        let grades: Partial<Record<TestTool, CheckResult>> | null = null
        const dryChecks: CheckResult[] = []
        if (productionHost === null) {
          sub("! No production domain is known yet; the live test is skipped", "warn")
          dryChecks.push(syntheticCheck("dry_live", "undetermined", "no production domain", at(), runId))
        } else {
          const request = beforeDryLiveRequest({ requestId: newRequestId(), runId, productionHost, pages: jobScan.detections.pages, framework: scan.framework, keys, expect })
          const errors = testRequestModeErrors(request, (host) => host === productionHost || host.endsWith(`.${productionHost}`) || productionHost.endsWith(`.${host}`))
          if (request.clicks || request.fakeClickId || errors.length > 0) throw new Error(`before built an invalid dry_live request: ${errors.join("; ")}`)
          sub(`Test load of ${productionHost} (nothing sent)…`, "pending")
          const { result, error } = await runDryLive(ctx, deps, request)
          if (result === null) {
            sub(`! The live test did not finish (${error ?? "unknown"}); its checks stay unknown`, "warn")
            dryChecks.push(syntheticCheck("dry_live", "undetermined", "test_error", at(), runId))
          } else {
            dryLive = result
            const graded = await deps.checks.gradeTestRun(result, expect, "dry_live", {
              cmpDetected: result.environment.cmpDetected ?? cmpDetectedStatic,
              envSourcedIds: census.envSourcedIds
            })
            grades = graded
            for (const tool of Object.keys(graded) as TestTool[]) {
              const check = graded[tool]
              dryChecks.push(check)
              if (check.state === "problem") sub(`! ${TOOL_LABEL[tool]}: ${check.reason ?? "problem"} on ${productionHost}`, "warn")
            }
          }
        }

        // ---- T1 live checks (read-only) ----
        const liveChecks: CheckResult[] = []
        if (productionHost !== null) {
          const urls = dryLive ? dryLive.loads.map((load) => load.url) : [`https://${productionHost}/`]
          liveChecks.push(...(await deps.checks.liveBytes(urls, expect)))
          liveChecks.push(...(await deps.checks.redirectWalk([`https://${productionHost}/`])))
          liveChecks.push(...(await deps.checks.csp(`https://${productionHost}/`)))
          if (expect.meta && expect.meta.length > 0) {
            const domains = [...new Set([...keys.infinite.productionHosts, ...(hosting.vercel?.productionDomains ?? [])].map(normalizeHost))]
            liveChecks.push(...(await deps.checks.metaDomains(domains, expect.meta)))
          }
        }

        // ---- the cloud's baseline reads ----
        const baseline: BaselineResponseFields = withoutEnvelope(await deps.bridge.baseline(runId, { signal: ctx.signal }))

        // ---- the Before facts (for the report builder; no cell is written here) ----
        const checks = [...setupChecks, ...envTargetChecks, ...dryChecks, ...liveChecks]
        const finalHost = dryLive?.loads[0]?.finalUrl ? normalizeHost(new URL(dryLive.loads[0].finalUrl).hostname) : null
        const facts: BeforeFacts = { hosting, keys, census, dryLive, checks, observedProductionHost: finalHost }
        const factsFile: BeforeFactsFile = {
          schema: BEFORE_FACTS_SCHEMA,
          runId,
          measuredAt: at(),
          productionHost,
          scan: { framework: scan.framework, packageManager: scan.packageManager, appRoot: scan.appRoot, fileCount: scan.fileCount, truncated: scan.truncated },
          facts,
          grades,
          setupChecks,
          envTargetChecks,
          liveChecks,
          baselineBuild,
          baseline,
          cmpDetected: dryLive?.environment.cmpDetected ?? cmpDetectedStatic
        }
        await deps.fs.mkdirp(join(ctx.root, WIZARD_PATHS.dir), 0o700)
        await deps.fs.writeTextAtomic(join(ctx.root, BEFORE_FACTS_PATH), `${JSON.stringify(factsFile, null, 2)}\n`, 0o600)
        for (const check of checks) {
          ctx.emit.emit("check.result", { checkId: check.checkId, tier: check.tier, state: check.state, ...(check.reason ? { reason: check.reason } : {}), runId })
        }

        // A few findings worth a live line (the plan step turns them into lines; nothing is decided here).
        for (const duplicate of detectDuplicates(census, dryLive)) {
          if (duplicate.kind === "gtm_and_gtag") sub("! GA4 also loaded by Tag Manager (counts every visit twice)", "warn")
          else sub(`! ${TOOL_LABEL[duplicate.tool]} is set up more than once`, "warn")
        }
        if (detectAdoptedPosthogConfig(jobScan.snapshot, census).some((config) => config.sendsDirect)) sub("! PostHog sends direct (ad blockers drop it)", "warn")

        // ---- checklist candidates (deterministic; nothing from an agent) ----
        const candidates = deps.registry.seedCandidates(jobScan, facts)
        ctx.state.update((state) => {
          state.jobs = candidates
          state.markers.before = dryLive
            ? { infiniteEventIds: dryLive.markers.infiniteEventIds, posthogDistinctId: dryLive.markers.posthogDistinctId, probePath: null, metaEventIds: dryLive.markers.metaEventIds }
            : {}
        })
        await ctx.state.save()

        const counts = summarize(checks)
        const status = `Before: ${counts.pass} pass · ${counts.problem} problem${counts.problem === 1 ? "" : "s"} · ${counts.unknown} unknown`
        ctx.emit.emit("step.status", { step: "before", text: status })
        return { kind: "ok", status }
      } catch (error) {
        const blocked = appBlockedOutcome(error)
        if (blocked) return blocked
        throw error
      }
    }
  }
}

/** Builds a JobScan from an already-loaded snapshot (for callers that hold one). */
export function jobScanWith(snapshot: RepoSnapshot): (scan: ScanResult) => JobScan {
  return (scan) => jobScanFrom(scan, snapshot)
}

export const step: WizardStep<"before"> = createBeforeStep()
