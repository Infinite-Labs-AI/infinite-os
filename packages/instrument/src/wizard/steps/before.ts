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
// - no report cell is computed here: the facts go to `.infinite/wizard/before.json` (the ONE
//   hand-off file lanes O7 and O2 read), and the live_today column is built by lane O1's column builder
//   from the typed readings `liveTodayColumnInput` maps (injected as `buildLiveTodayColumn`); the step
//   status only COUNTS the wizard's own check states;
// - an undetermined check (held by consent, bot rules, a test error) is never counted as a problem;
// - a busy test engine or a cloud blip leaves the dry load / the baseline unknown, never crashes the run
//   (review P2-6); only a missing subscription or a signed-out app stops it.
//
// Call order (asserted by `before.test.ts`): hosting (the base is `hosting.vercel.productionBranch`,
// §3g.1) → branch → keys → baseline build → scan + census + setup checks → dry_live → T1 → baseline
// reads → Before facts → seedCandidates. The branch is created before any other verb and before any
// repo read.
import { asBridgeFailure, bridgeFailureOutcome, hardStopOutcome, isTransientBridgeFailure } from "../../bridge/outcomes.js"
import { envNamesFor } from "../../checks/live/env-targets.js"
import { gradeContextFrom } from "../../checks/grade-context.js"
import { BEFORE_FACTS_SCHEMA, writeBeforeFactsFile, type BeforeFactsFile } from "../handoff/before-facts.js"
import { createHash } from "node:crypto"
import { join } from "node:path"

import { scanForJobs, jobScanFrom, type JobScan } from "../../jobs/detectors/index.js"
import { detectDuplicates } from "../../jobs/detectors/duplicates.js"
import { liveTodayColumnInput, gradeWords, type LiveTodayColumnInput } from "../before-column.js"
import { detectAdoptedPosthogConfig } from "../../jobs/detectors/adopted-tags.js"
import type { RepoSnapshot } from "../../jobs/repo-files.js"
import { BRIDGE_ERROR_CODES, type BridgeErrorCode, type TagHosting, type TagKeys } from "../contracts/bridge.js"
import type { WizardCode } from "../contracts/codes.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { normalizeHost } from "../contracts/host-deny.js"
import type { BeforeFacts, BuildResult, CheckResult, ScanResult } from "../contracts/jobs.js"
import type { WizardFs } from "../contracts/deps.js"
import type { BaselineResponseFields, ReportColumnSnapshot } from "../contracts/report.js"
import type { BaseSource, WizardRunState } from "../contracts/state.js"
import { WIZARD_PATHS } from "../contracts/state.js"
import { wizardBranchName } from "../contracts/git-host.js"
import { wizardGitExtras } from "../../git/index.js"
import { buildColumn } from "../report.js"
import { EVENT_LIMITS } from "../contracts/events.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import { askProductionHost, hostDecidedLines, repoHostCandidates, resolveProductionHost } from "../site-host.js"
import { blockingDirtyPaths, dirtyTreeMessage, resetStaleReceipt } from "../leftovers.js"
import { homedir } from "node:os"
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

// The hand-off file lives in ONE module (B1); `before` writes it, `keys` and `plan` / `install` read it.
export {
  BEFORE_FACTS_PATH,
  BEFORE_FACTS_SCHEMA,
  readBeforeFactsFile,
  writeBeforeFactsFile,
  type BeforeFactsFile,
  type BeforeFactsWithBaseline
} from "../handoff/before-facts.js"

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const TOOL_LABEL: Record<TestTool, string> = { infinite: "Infinite", ga4: "GA4", posthog: "PostHog", meta: "Meta pixel" }
/** Frameworks whose page changes are client-side: a test load runs one `spaNavigation` there (before and after the deploy). */
export const SPA_FRAMEWORKS: ReadonlySet<string> = new Set(["next-app-router", "next-pages-router", "vite-react"])

/** The bridge error code of a thrown bridge error (lane O2's `BridgeError {status, code, retryable}`), else null. */
export function bridgeErrorCode(error: unknown): BridgeErrorCode | null {
  if (typeof error !== "object" || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && (BRIDGE_ERROR_CODES as readonly string[]).includes(code) ? (code as BridgeErrorCode) : null
}

/** Bridge failures that stop `before`: the §3z.4 table (one place, `bridge/outcomes.ts`). */
function appBlockedOutcome(error: unknown): StepOutcome | null {
  return bridgeFailureOutcome(error)
}

/** Bridge errors that leave a measurement unknown instead of stopping the run (busy, timeouts, 5xx; §3z.4). */
const DEGRADABLE: ReadonlySet<BridgeErrorCode> = new Set(["busy", "rate_limited", "cloud_error", "upstream_timeout", "capability_unavailable", "internal_error"])
/** The test engine runs one test at a time (§3a.8): a busy engine is retried, then the load is unknown. */
const RETRYABLE: ReadonlySet<BridgeErrorCode> = new Set(["busy", "rate_limited"])
export const DRY_LIVE_START_ATTEMPTS = 4
export const DRY_LIVE_RETRY_BASE_MS = 2_000

function isDegradable(error: unknown): boolean {
  const code = bridgeErrorCode(error)
  if (code === null) return false
  // A damaged link store (internal_error, not retryable) is never "unknown": it stops the run.
  if (code === "internal_error") return isTransientBridgeFailure(error)
  return DEGRADABLE.has(code)
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

/** The git dir of `root` (a worktree's `.git` file points at it). */
async function gitDirOf(deps: Pick<WizardDeps, "fs">, root: string): Promise<string> {
  const dotGit = await deps.fs.readText(join(root, ".git")).catch(() => null)
  if (dotGit !== null && dotGit.startsWith("gitdir:")) {
    const dir = dotGit.slice("gitdir:".length).trim()
    return dir.startsWith("/") ? dir : join(root, dir)
  }
  return join(root, ".git")
}

/** The checked-out branch (`.git/HEAD`'s `ref: refs/heads/<name>`), or null (detached or unreadable). */
export async function readCurrentBranch(deps: Pick<WizardDeps, "fs">, root: string): Promise<string | null> {
  const head = await deps.fs.readText(join(await gitDirOf(deps, root), "HEAD")).catch(() => null)
  const match = head ? /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(head) : null
  return match ? match[1]! : null
}

/** §3g.1 base: Vercel's production branch, else the GitHub default branch, else origin/HEAD. */
export async function resolveBase(
  deps: Pick<WizardDeps, "host" | "fs">,
  hosting: TagHosting,
  root: string
): Promise<{ base: string; baseSource: BaseSource } | null> {
  if (hosting.provider === "vercel" && hosting.vercel?.productionBranch) return { base: hosting.vercel.productionBranch, baseSource: "vercel" }
  // A host CLI that is installed but not signed in must not stop the run: origin/HEAD still names it.
  const facts = await deps.host.repoFacts().catch(() => null)
  if (facts && !("unsupported" in facts) && facts.defaultBranch) return { base: facts.defaultBranch, baseSource: "default_branch" }
  const originHead = await readOriginHead(deps, root)
  return originHead ? { base: originHead, baseSource: "origin_head" } : null
}

/**
 * The production host the dry load visits (§3y.1, one precedence for every consumer): the site source's first
 * host, else Vercel's first domain, else this run's answer, else `--production-host`.
 */
export function productionHostOf(keys: TagKeys, hosting: TagHosting, site: WizardRunState["site"] | null = null, flag: string | null = null): string | null {
  return resolveProductionHost({ keys, hosting, site, flag }).host
}

/**
 * §3y.1: decides the run's production host ONCE (right after the silent keys read, before the baseline build).
 * Infinite's own host, an earlier answer or the flag decide it; otherwise ONE ask, pre-filled with the repo's
 * hints. `--yes` and nested mode never answer it: the run goes on with no host (never a guess).
 */
export async function decideProductionHost(
  ctx: WizardContext,
  deps: WizardDeps,
  keys: TagKeys,
  hosting: TagHosting,
  sub: (text: string, tone?: "ok" | "warn" | "info" | "pending") => void
): Promise<string | null> {
  const current = ctx.state.get().site ?? null
  const resolved = resolveProductionHost({ keys, hosting, site: current, flag: ctx.options.productionHost ?? null })
  let host = resolved.host
  let source = resolved.source
  if (!resolved.decided) {
    if (ctx.options.yes || ctx.options.nested) {
      sub("! No live site address: --yes never answers that; pass --production-host <domain> to test it", "warn")
      return null
    }
    const facts = await deps.host.repoFacts().catch(() => null)
    const homepageUrl = facts && !("unsupported" in facts) ? (facts.homepageUrl ?? null) : null
    // Founder ruling 2026-10-03: only the site's own domain, so no `*.vercel.app` candidate is ever derived or offered.
    const candidates = await repoHostCandidates(ctx.root, ctx.appRoot, deps.fs, { homepageUrl })
    host = await askProductionHost(ctx, candidates, (text, tone) => sub(text, tone))
    source = "answer"
  }
  if (source !== null && (!current || current.productionHost !== host || current.source !== source)) {
    const decidedAt = deps.clock.now().toISOString()
    ctx.state.update((state) => {
      state.site = { ...(state.site ?? {}), productionHost: host, source: source!, decidedAt }
    })
    await ctx.state.save()
  }
  if (source !== "infinite") for (const line of hostDecidedLines(host, source)) sub(line, host ? "ok" : "warn")
  return host
}

/**
 * The sanity line after the dry load (DECISIONS §1.1, should): the repo's own provider IDs, none of which the live
 * page showed, hint the answered host is not this repo's site. A line only; nothing changes.
 */
export function liveIdMismatchLines(census: BeforeFacts["census"], dryLive: TestResult, host: string): string[] {
  const seen: Record<"ga4" | "posthog" | "meta", Set<string>> = {
    ga4: new Set(dryLive.ga4.events.map((event) => event.tid)),
    posthog: new Set(dryLive.posthog.events.map((event) => event.projectKey)),
    meta: new Set(dryLive.meta.configRequests)
  }
  const lines: string[] = []
  for (const tool of ["ga4", "posthog", "meta"] as const) {
    const ids = [...new Set(census.entries.filter((entry) => entry.tool === tool && entry.owner === "adopted" && entry.id).map((entry) => entry.id!))]
    if (ids.length === 0 || ids.some((id) => seen[tool].has(id))) continue
    lines.push(`! ${host} doesn't show the ${TOOL_LABEL[tool]} ID in your code (${ids[0]}); check it's this repo's live site.`)
  }
  return lines
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

/** The host the dry load finally landed on (after redirects), or null. */
function finalHostOf(result: TestResult): string | null {
  const finalUrl = result.loads[0]?.finalUrl
  if (!finalUrl) return null
  try {
    return normalizeHost(new URL(finalUrl).hostname)
  } catch {
    return null
  }
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
  let started: { testRunId: string } | null = null
  for (let attempt = 1; started === null; attempt += 1) {
    try {
      started = await deps.bridge.startTest(body, { signal: ctx.signal })
    } catch (error) {
      const code = bridgeErrorCode(error)
      if (code === null || !isDegradable(error)) throw error
      if (!RETRYABLE.has(code) || attempt >= DRY_LIVE_START_ATTEMPTS) return { result: null, error: code === "busy" ? "the Infinite app is busy with another test" : code }
      await deps.clock.sleep(DRY_LIVE_RETRY_BASE_MS * 2 ** (attempt - 1), ctx.signal)
    }
  }
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
    if (ctx.signal.aborted || isDegradable(error)) await deps.bridge.cancelTest(started.testRunId).catch(() => undefined)
    if (!ctx.signal.aborted && isDegradable(error)) return { result: null, error: bridgeErrorCode(error) }
    throw error
  }
}

/**
 * The hosting read the `env_targets` check grades (review I2 P1-2). It asks ONLY the names §3b allows (at
 * most 10, `^(NEXT_PUBLIC|VITE|PUBLIC)_[A-Z0-9_]{1,64}$`, `envNamesFor`): a server-side name is never sent,
 * and the check reads it `undetermined` (server env, so not a preview leak). With no askable name there is
 * no second read. The read is optional, so a bridge failure goes through the §3z.4 table: a hard stop
 * (402, signed out, the link) stops the step; anything else (a 4xx such as `invalid_request`, a 5xx, busy)
 * leaves the hosting answer without `envTargets`, which the check reads as `undetermined`, never a pass.
 */
async function envTargetsHosting(
  ctx: WizardContext,
  deps: WizardDeps,
  hosting: TagHosting,
  envSourcedIds: CensusEnvSourcedIds,
  sub: (text: string, tone?: "ok" | "warn" | "info" | "pending") => void
): Promise<TagHosting> {
  // The first hosting read asked for no names, so any `envTargets` on it answer nothing: never graded.
  const unread: TagHosting = hosting.vercel ? { ...hosting, vercel: withoutEnvTargets(hosting.vercel) } : hosting
  const envNames = envNamesFor(envSourcedIds)
  if (envNames.length === 0) return unread
  try {
    return withoutEnvelope(await deps.bridge.hosting(envNames, { signal: ctx.signal }))
  } catch (error) {
    if (ctx.signal.aborted || hardStopOutcome(error) !== null || asBridgeFailure(error) === null) throw error
    sub("! Infinite could not read where your env-sourced IDs are set on Vercel; that check stays unknown", "warn")
    return unread
  }
}

function withoutEnvTargets(vercel: NonNullable<TagHosting["vercel"]>): NonNullable<TagHosting["vercel"]> {
  const { envTargets: _unasked, ...rest } = vercel
  return rest
}

type CensusEnvSourcedIds = Parameters<WizardDeps["checks"]["envTargets"]>[0]

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
  /**
   * Lane O1's column builder for the live_today column (`(input) => buildColumn("live_today", input)`;
   * wired at integration, I1). `before` computes no cell itself: without a builder the column stays null.
   */
  buildLiveTodayColumn?: (input: LiveTodayColumnInput) => ReportColumnSnapshot
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
      // The cap is the event's own (240, R2-3): the host refusal (founder ruling 2026-10-03) must never be cut mid-word.
      const sub = (text: string, tone: "ok" | "warn" | "info" | "pending" = "info") => ctx.emit.emit("step.sub", { step: "before", text: text.slice(0, EVENT_LIMITS.subTextMaxChars), tone })
      const at = () => deps.clock.now().toISOString()

      // ---- preconditions ----
      if (!(await deps.git.isRepo())) {
        return { kind: "failed", code: "INF_WIZ_NO_GIT", message: "This folder is not a git repository. Run npx infinite-tag in your website's repo.", next: "halt" }
      }
      const tree = await deps.git.cleanTree()
      const dirty = blockingDirtyPaths(tree.dirtyPaths)
      if (!tree.clean && dirty.length > 0) return { kind: "failed", code: "INF_WIZ_DIRTY_TREE", message: dirtyTreeMessage(dirty), next: "halt" }
      const runId = ctx.runId
      if (runId === null) {
        return { kind: "failed", code: "INF_WIZ_BRANCH_FAILED", message: "No run id: the agent step did not start the run, so the branch cannot be named.", next: "halt" }
      }

      try {
        // ---- hosting (read-only; the base is the production branch) → branch ----
        const hosting: TagHosting = withoutEnvelope(await deps.bridge.hosting(undefined, { signal: ctx.signal }))
        const existing = ctx.state.get().git
        if (existing?.branch) {
          // A resumed run must be ON its branch: otherwise the scan reads (and later steps edit) whatever
          // the user switched to (review P2-7). The tree is clean (checked above), so the wizard switches
          // back itself (O4's `switchTo`); when it cannot, it stops and says what to run.
          let current = await readCurrentBranch(deps, ctx.root)
          let switched = false
          if (current !== existing.branch) {
            const ops = "switchTo" in deps.git ? wizardGitExtras(deps.git) : null
            if (ops) {
              try {
                await ops.switchTo(existing.branch)
                current = await ops.currentBranch()
                switched = current === existing.branch
              } catch {
                // Reported below as BRANCH_FAILED with the command to run.
              }
            }
          }
          if (current !== existing.branch) {
            return {
              kind: "failed",
              code: "INF_WIZ_BRANCH_FAILED",
              message: `This run works on ${existing.branch}, but ${current ? `${current} is` : "no branch is"} checked out. Run \`git switch ${existing.branch}\`, then npx infinite-tag again.`,
              next: "halt"
            }
          }
          // B25: a run rebuilt from its PR marker on a fresh machine knows its branch and base, not its base SHA.
          if (existing.baseSha === "") {
            const ops = "mergeBase" in deps.git ? wizardGitExtras(deps.git) : null
            const remoteBase = await deps.git.remoteBranchSha(existing.base)
            const baseSha = ops?.mergeBase && remoteBase ? await ops.mergeBase(remoteBase, "HEAD") : null
            if (!baseSha) {
              return { kind: "failed", code: "INF_WIZ_BRANCH_FAILED", message: `Could not find where ${existing.branch} branched from origin/${existing.base}. Run npx infinite-tag --fresh.`, next: "halt" }
            }
            ctx.state.update((state) => {
              state.git = { ...existing, baseSha }
            })
            await ctx.state.save()
          }
          sub(`${switched ? "Switched back to" : "On"} branch ${existing.branch} (from ${existing.base})`, "ok")
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
          // §3y.8: a receipt with another run's never-merged records is set aside (only on a new branch, never a resume).
          const extras = "showFile" in deps.git ? wizardGitExtras(deps.git) : null
          if (extras) {
            const home = deps.env.HOME ?? homedir()
            const kept = await resetStaleReceipt({ root: ctx.root, fs: deps.fs, git: extras, baseSha, runId, home })
            if (kept) {
              sub("Set aside an install receipt that was never merged", "info")
              sub(`(kept in ${kept.startsWith(home) ? `~${kept.slice(home.length)}` : kept})`, "info")
            }
          }
        }

        // ---- keys, silently (connection IDs only; `expect` never comes from the repo) ----
        const keys: TagKeys = withoutEnvelope(await deps.bridge.keys({ signal: ctx.signal }))
        const expect = testExpectFromKeys(keys)

        // ---- §3y.1: the production host, decided once (Infinite, an earlier answer, the flag, or ONE ask) ----
        const productionHost = await decideProductionHost(ctx, deps, keys, hosting, sub)

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
          envTargetChecks = await deps.checks.envTargets(census.envSourcedIds, await envTargetsHosting(ctx, deps, hosting, census.envSourcedIds, sub))
        }

        // ---- dry_live of production (nothing sent; no clicks, no fake click id) ----
        const cmpDetectedStatic = jobScan.detections.cmp.cmp
        let dryLive: TestResult | null = null
        let grades: Partial<Record<TestTool, CheckResult>> | null = null
        const dryChecks: CheckResult[] = []
        let dryRequestedSpa = false
        let spaNavigation: { path: string } | null = null
        if (productionHost === null) {
          sub("! No production domain is known yet; the live test is skipped", "warn")
          dryChecks.push(syntheticCheck("dry_live", "undetermined", "no production domain", at(), runId))
        } else {
          const request = beforeDryLiveRequest({ requestId: newRequestId(), runId, productionHost, pages: jobScan.detections.pages, framework: scan.framework, keys, expect })
          dryRequestedSpa = request.spaNavigation !== undefined
          spaNavigation = request.spaNavigation ?? null
          const errors = testRequestModeErrors(request, (host) => host === productionHost || host.endsWith(`.${productionHost}`) || productionHost.endsWith(`.${host}`))
          if (request.clicks || request.fakeClickId || errors.length > 0) throw new Error(`before built an invalid dry_live request: ${errors.join("; ")}`)
          sub(`Test load of ${productionHost} (nothing sent)…`, "pending")
          const { result, error } = await runDryLive(ctx, deps, request)
          if (result === null) {
            sub(`! The live test did not finish (${error ?? "unknown"}); its checks stay unknown`, "warn")
            dryChecks.push(syntheticCheck("dry_live", "undetermined", "test_error", at(), runId))
          } else {
            dryLive = result
            // §3z.12 §3e.7 (B11): the live site's consent mode is the one Infinite records (null = unknown).
            const gradeCtx = gradeContextFrom({ census, consentMode: keys.infinite.consentMode, cmpDetected: result.environment.cmpDetected ?? cmpDetectedStatic, spaNavigation: dryRequestedSpa })
            const graded = await deps.checks.gradeTestRun(result, expect, "dry_live", gradeCtx)
            grades = graded
            // B12: lane O6's D10 result (an adopted pixel's automatic events) is stored with the checks, so the
            // plan reads this ONE count and never counts `tr` events itself.
            const d10 = (await deps.checks.gradeTestRunChecks(result, expect, "dry_live", gradeCtx)).find((check) => check.checkId === "meta_automatic_events")
            if (d10) dryChecks.push(d10)
            for (const tool of Object.keys(graded) as TestTool[]) {
              const check = graded[tool]
              dryChecks.push(check)
              if (check.state === "problem") sub(`! ${TOOL_LABEL[tool]} ${gradeWords(check, finalHostOf(result) ?? productionHost)}`, "warn")
            }
            // An address the user gave (not Infinite's): say when the live page shows none of the repo's own IDs.
            if (ctx.state.get().site?.source !== "infinite") for (const line of liveIdMismatchLines(census, result, productionHost)) sub(line, "warn")
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
            const domains = [...new Set([...keys.infinite.productionHosts, ...(hosting.vercel?.productionDomains ?? []), productionHost].map(normalizeHost))]
            liveChecks.push(...(await deps.checks.metaDomains(domains, expect.meta)))
          }
        }

        // ---- the cloud's baseline reads (a cloud blip leaves them unknown: null, never 0) ----
        let baseline: BaselineResponseFields | null = null
        try {
          baseline = withoutEnvelope(await deps.bridge.baseline(runId, { signal: ctx.signal }))
        } catch (error) {
          if (!isDegradable(error)) throw error
          sub("! Infinite could not read your analytics history right now; those numbers stay unknown", "warn")
        }

        // ---- the Before facts (the hand-off file; no cell is computed here) ----
        const checks = [...setupChecks, ...envTargetChecks, ...dryChecks, ...liveChecks]
        const finalHost = dryLive ? finalHostOf(dryLive) : null
        const facts: BeforeFacts = { hosting, keys, census, dryLive, checks, observedProductionHost: finalHost }
        const measuredAt = at()
        const loginFound = jobScan.detections.auth.login.length > 0
        const factsFile: BeforeFactsFile = {
          schema: BEFORE_FACTS_SCHEMA,
          runId,
          writtenAt: measuredAt,
          measuredAt,
          productionHost,
          scan: { framework: scan.framework, packageManager: scan.packageManager, appRoot: scan.appRoot, fileCount: scan.fileCount, truncated: scan.truncated },
          facts: { ...facts, baseline, baselineBuild },
          grades,
          setupChecks,
          envTargetChecks,
          liveChecks,
          cmpDetected: dryLive?.environment.cmpDetected ?? cmpDetectedStatic,
          loginFound,
          // Only a navigation that was measured (a dry load that came back) is one to repeat.
          spaNavigation: dryLive ? spaNavigation : null
        }
        await writeBeforeFactsFile(deps.fs, ctx.root, factsFile)
        const duplicates = detectDuplicates(census, dryLive)
        const liveToday = options.buildLiveTodayColumn
          ? options.buildLiveTodayColumn(
              liveTodayColumnInput({
                runId,
                measuredAt,
                keys,
                expect,
                census,
                dryLive,
                grades,
                liveChecks,
                baseline,
                repeatedInits: duplicates.filter((entry) => entry.kind === "repeated_init" && entry.id !== null).map((entry) => ({ tool: entry.tool, id: entry.id!, count: entry.evidence.length })),
                loginFound,
                spaNavigationRequested: dryRequestedSpa
              })
            )
          : null
        for (const check of checks) {
          ctx.emit.emit("check.result", { checkId: check.checkId, tier: check.tier, state: check.state, ...(check.reason ? { reason: check.reason } : {}), runId })
        }

        // A few findings worth a live line (the plan step turns them into lines; nothing is decided here).
        for (const duplicate of duplicates) {
          if (duplicate.kind === "gtm_and_gtag") sub("! GA4 also loaded by Tag Manager (set up twice)", "warn")
          else sub(`! ${TOOL_LABEL[duplicate.tool]} is set up more than once`, "warn")
        }
        if (detectAdoptedPosthogConfig(jobScan.snapshot, census).some((config) => config.sendsDirect)) sub("! PostHog sends direct (ad blockers drop it)", "warn")

        // ---- checklist candidates (deterministic; nothing from an agent) ----
        const candidates = deps.registry.seedCandidates(jobScan, facts)
        ctx.state.update((state) => {
          state.jobs = candidates
          if (liveToday) state.report.live_today = liveToday
          state.markers.before = dryLive
            ? { infiniteEventIds: dryLive.markers.infiniteEventIds, posthogDistinctId: dryLive.markers.posthogDistinctId, probePath: null, metaEventIds: dryLive.markers.metaEventIds }
            : {}
        })
        await ctx.state.save()

        const status = beforeStatus(liveToday, checks)
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

/**
 * The step's closing line. It is the report's own "Checks passing" cell for the "Live site today" column, word
 * for word, so the terminal never shows two different "before" counts in the same words (final verify F4: the
 * step used to count every raw check result, the report counts the 14 finish-line checks). With no column
 * (a wiring without the column builder, or a column with nothing determinable) the line names what it counts.
 */
export function beforeStatus(liveToday: ReportColumnSnapshot | null, checks: readonly CheckResult[]): string {
  const cell = liveToday?.cells.checks_passing
  if (cell && cell.value !== null) return `Before: ${cell.display}`
  const counts = summarize(checks)
  return `Before: ${checks.length} code and live check${checks.length === 1 ? "" : "s"} run · ${counts.pass} pass · ${counts.problem} problem${counts.problem === 1 ? "" : "s"} · ${counts.unknown} unknown`
}

/** Builds a JobScan from an already-loaded snapshot (for callers that hold one). */
export function jobScanWith(snapshot: RepoSnapshot): (scan: ScanResult) => JobScan {
  return (scan) => jobScanFrom(scan, snapshot)
}

/** Lane O1's column builder for `before`'s readings (the production step's `buildLiveTodayColumn`). */
export const buildLiveTodayColumn = (input: LiveTodayColumnInput): ReportColumnSnapshot => buildColumn("live_today", input)

/** The production step: the "Live site today" column is built by lane O1's builder. */
export const step: WizardStep<"before"> = createBeforeStep({ buildLiveTodayColumn })
