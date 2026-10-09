import { buildScanner, runPublicIds } from "../../review/context.js"
import { safeDisplayText } from "../../review/display.js"
import { loadPlanApprovals } from "../../install/step-inputs.js"
import type { ChecklistItem } from "../contracts/jobs.js"
import { withheldPreviewTools, previewScope } from "../../review/preview-scope.js"
// Step 11 `prove` (§3d.1): after the merge is deployed, ONE real test visit and the best proof each tool
// can give, from THIS run.
//
// 1. Wait for the deploy of the merge commit: deployed when the merge SHA's own production deployment
//    is READY, or when the SERVING production deployment's SHA descends from the merge SHA
//    (`git fetch origin <productionBranch>` then `git merge-base --is-ancestor <mergeSha> <servingSha>`),
//    so a canceled or skipped merge build never waits forever. Never on the PR head SHA.
// 2. Claim the proof (`POST /v1/runs/:runId/proof-claim {producer:"tag"}`). Only the winner runs the
//    `real_visit` (exactly one target: the production root, plus the server-lane probe). The loser, or a
//    run already proving/proven, reads the existing receipts and NEVER triggers a second real visit.
// 3. Receipts (waitMs 120 s, re-polled every 10 s; the server lane only when it is installed), T1 checks after the
//    deploy, and §3x.6's three post-deploy measurements (production's own bytes for duplicates, a no-send load of
//    the merge's own deployment URL for previews, a no-send load of production with a page change), the
//    `proven_live` column over every INSTALLED tool, then `PATCH proofState` from THE verdict (winner only).
// 4. Print what the customer filters the one normal page view by (GA4 client id, PostHog id, Meta PageView time).
import { bridgeFailureOutcome, hardStopOutcome, isTransientBridgeFailure } from "../../bridge/outcomes.js"
import { deploymentReader, type DeploymentReader } from "../../hosts/github.js"
import { resolveProductionHost } from "../site-host.js"
import { resolveVercelSignal } from "../vercel-signal.js"
import { gradeContextFrom } from "../../checks/grade-context.js"
import { createHash } from "node:crypto"
import { join } from "node:path"

import { SITE_PROOF_PATH, type ProveOutcome, type SiteProveResponse, type TagKeys, type TestRunPollResponse } from "../contracts/bridge.js"
import type { WizardGitOps } from "../contracts/git-host.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import { LIVE_TIERS } from "../../jobs/state-machine.js"
import type { CheckResult } from "../contracts/jobs.js"
import { TEST_TOOLS } from "../contracts/test-engine.js"
import { GA4_REALTIME_BEFORE_MINUTES, GA4_REALTIME_REASONS, RECEIPT_LANES, RECEIPT_LIMITS, type Ga4RealtimeReason, type LaneReceipt, type ReceiptLane, type ReceiptMarkers, type ReceiptsResponseFields } from "../contracts/receipts.js"
import { REASONS, type Reason, type ReportColumnSnapshot } from "../contracts/report.js"
import { WIZARD_PATHS, type WizardRunState } from "../contracts/state.js"
import { WIZARD_STEP_META } from "../contracts/steps.js"
import {
  TEST_LIMITS,
  serverLaneProbePathFor,
  testExpectFromKeys,
  type TestExpect,
  type TestResult,
  type TestTool
} from "../contracts/test-engine.js"
import { bridgeErrorCode, bridgeErrorState } from "../bridge-errors.js"
import { gradeReasonCode, gradeWords } from "../before-column.js"
import { buildColumn, type ColumnFact, type RowCellInput } from "../report.js"
import { PREVIEW_REFUSED, previewNeedsLogin, productionMatcher, rehearsalTargets, runDesktopTest } from "../../review/rehearse.js"
import { GhError } from "../../github/gh.js"
import { testPageUrls } from "./rehearsal.js"
import { readBeforeFactsFile } from "../handoff/before-facts.js"
import { HOST_DENY_V1, normalizeHost } from "../contracts/host-deny.js"
import type { RunProofState } from "../contracts/state.js"
import type { VerdictToolFact } from "../contracts/report.js"
import type { CensusResult } from "../contracts/jobs.js"
import { verdictFactsFor } from "../verdict-facts.js"
import { proofStateOf } from "../verdict.js"
import { proveCommerce, type CommerceProofLine } from "./prove-commerce.js"
import { readEventInventory } from "../../checks/commerce-inventory.js"
import { loadRepoSnapshot } from "../../jobs/repo-files.js"

/** How often the deploy status is read, and how long `prove` waits before parking (the desktop watcher continues). */
export const PROVE_LIMITS = {
  deployPollMs: 15_000,
  deployWaitMs: 20 * 60_000,
  /** §3y.4: the site-file proof is asked at most this often while the deploy is awaited (the cloud allows 120/h). */
  claimPollMs: 60_000,
  /** §3y.4: once deployed, a pending claim is re-asked this long (a CDN may serve the old build briefly). */
  claimGraceMs: 3 * 60_000,
  claimGracePollMs: 30_000,
  /** At most one "still waiting" line this often. */
  waitLineEveryMs: 2 * 60_000,
  testPollWaitSeconds: 25,
  /** Above the real visit's own 90 s deadline: the desktop enforces it; this only stops a wedged poll. */
  realVisitClientMs: TEST_LIMITS.deadlineMs.real_visit + 60_000
} as const

const TOOL_LANES: Record<TestTool, ReceiptLane> = { infinite: "infinite", posthog: "posthog", ga4: "ga4", meta: "meta_pixel" }
const TOOL_LABELS: Record<TestTool, string> = { infinite: "Infinite pixel", posthog: "PostHog", ga4: "GA4", meta: "Meta" }

function hashOf(parts: unknown[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`
}

// ---------------------------------------------------------------------------------------------
// 1. The deploy
// ---------------------------------------------------------------------------------------------

export type DeployHow = "merge_deployment" | "serving_descends" | "github_deployment" | "site_file" | "you_said"
export type DeployWait = { deployed: true; sha: string; how: DeployHow } | { deployed: false }

/** One read of the deploy status: deployed now, or not yet. */
export async function mergeIsDeployed(deps: WizardDeps, mergeSha: string, productionBranch: string | null): Promise<DeployWait> {
  let status: Awaited<ReturnType<WizardDeps["bridge"]["deployStatus"]>>
  try {
    status = await deps.bridge.deployStatus(mergeSha)
  } catch (error) {
    // §3z.4: Infinite or Vercel did not answer this poll: "not yet", and the wait goes on.
    if (isTransientBridgeFailure(error)) return { deployed: false }
    throw error
  }
  // §3z.6 (A30): a merge deployment in `error` is treated like `canceled` (the serving commit decides), and
  // `serving:null` (nothing built from Git is serving) is "not yet", never "nothing deployed".
  if (status.mergeDeployment?.state === "ready") return { deployed: true, sha: mergeSha, how: "merge_deployment" }
  const serving = status.serving?.sha ?? null
  if (!serving) return { deployed: false }
  if (serving === mergeSha) return { deployed: true, sha: mergeSha, how: "merge_deployment" }
  return (await descends(deps, mergeSha, serving, productionBranch)) ? { deployed: true, sha: serving, how: "serving_descends" } : { deployed: false }
}

/** `mergeSha` is in `serving`'s history (the production branch fetched first: the serving commit may be newer). */
async function descends(deps: WizardDeps, mergeSha: string, serving: string, productionBranch: string | null): Promise<boolean> {
  if (productionBranch) await deps.git.remoteBranchSha(productionBranch)
  try {
    return await deps.git.isAncestor(mergeSha, serving)
  } catch {
    // An unknown commit (not fetched yet) is "not yet", never "deployed".
    return false
  }
}

/** §3y.4: what one GitHub read says about the merge's production deploy. */
export type GithubDeployRead = { deployed: true; sha: string; how: "github_deployment" | "serving_descends" } | { failed: true; reason?: string; blocked?: boolean } | { waiting: "building" | "not_found" } | { unavailable: true; reason: string }

export async function githubDeployRead(deps: WizardDeps, reader: DeploymentReader, mergeSha: string, productionBranch: string | null): Promise<GithubDeployRead> {
  const own = await reader.productionDeployment(mergeSha).catch(() => null)
  if (own?.state === "ready") return { deployed: true, sha: mergeSha, how: "github_deployment" }
  // A later successful production deployment that contains the merge serves it too (a canceled or failed merge build).
  const latest = await reader.latestProductionDeployment().catch(() => undefined)
  if (latest && latest.sha === mergeSha) return { deployed: true, sha: mergeSha, how: "github_deployment" }
  if (latest && (await descends(deps, mergeSha, latest.sha, productionBranch))) return { deployed: true, sha: latest.sha, how: "serving_descends" }
  if (own?.state === "failed") return { failed: true, ...(own.reason ? { reason: own.reason } : {}), ...(own.blocked ? { blocked: true } : {}) }
  if (own?.state === "building") return { waiting: "building" }
  if (own === null || latest === undefined) return { unavailable: true, reason: "GitHub's production deployment status could not be read; whether this merge is live is unknown." }
  if (latest === null) return { unavailable: true, reason: "GitHub shows no production deployment status for this merge and no earlier successful production deployment; whether this merge is live is unknown." }
  return { waiting: "not_found" }
}

/** The signals `prove` can wait on this run (§3y.4). With none, it asks instead of waiting. */
export interface DeploySignals {
  /** Infinite's Vercel connection (`hosting.deploy`). */
  infinite: boolean
  /** GitHub Deployments (a Vercel signal, or production deployments seen). */
  github: DeploymentReader | null
  /** A pending site-file claim the cloud can check. */
  claim: boolean
}

/**
 * `no_signal`: no remaining source can report THIS merge's deploy. GitHub may have no visible production history,
 * or a proven claim's file was already served before this merge. The step asks rather than guessing success.
 */
export type DeployOutcome = (DeployWait & { deployed: true }) | { deployed: false; why: "timeout" | "failed" | "no_signal" | "claim_gone"; reason?: string; blocked?: boolean }

/**
 * Review P3-1: the cloud reading the proof file shows THIS merge deployed only when the merge brought that file:
 * the merge commit holds it, and its first parent (what production served before) did not hold the same bytes.
 * A refreshed claim keeps its token, so a file live from an earlier merge (e.g. `--fresh` after a merged but
 * unproven run) would otherwise read as a deploy nobody measured. Unknown (no `showFile`, an unfetched commit) is
 * false: never a guess.
 */
export async function mergeBroughtProofFile(ctx: WizardContext, deps: WizardDeps, mergeSha: string, productionBranch: string | null): Promise<boolean> {
  const git = deps.git as Partial<WizardGitOps>
  if (typeof git.showFile !== "function") return false
  const showFile = git.showFile.bind(deps.git)
  // The merge happened on the host: fetch the production branch so the merge commit is known here.
  if (productionBranch) await deps.git.remoteBranchSha(productionBranch).catch(() => null)
  const rest = SITE_PROOF_PATH.replace(/^\//, "")
  const prefix = ctx.appRoot === "." || ctx.appRoot === "" ? "" : `${ctx.appRoot}/`
  // The two places `proofFileTarget` writes it (Next/Vite `public/`, a static site's root).
  for (const path of [`${prefix}public/${rest}`, `${prefix}${rest}`]) {
    const merged = await showFile(mergeSha, path).catch(() => null)
    if (merged === null) continue
    const before = await showFile(`${mergeSha}^1`, path).catch(() => null)
    return before !== merged
  }
  return false
}

/** The step's sub line, throttled to one "still waiting" line per two minutes. */
function waitLines(ctx: WizardContext, deps: WizardDeps): (text: string) => void {
  let last = -Infinity
  return (text) => {
    const now = deps.clock.now().getTime()
    if (now - last < PROVE_LIMITS.waitLineEveryMs) return
    last = now
    ctx.emit.emit("step.sub", { step: "prove", text, tone: "pending" })
  }
}

/** One `site-prove` call; transient failures and refusals read "pending" (the desktop and the hourly watch go on). */
async function proveOnce(ctx: WizardContext, deps: WizardDeps): Promise<SiteProveResponse | null> {
  try {
    return await deps.bridge.proveSite({ signal: ctx.signal })
  } catch (error) {
    if (hardStopOutcome(error) !== null) throw error
    if (isTransientBridgeFailure(error) || bridgeErrorCode(error) !== null) return null
    throw error
  }
}

/**
 * §3y.4: waits on EVERY available signal (Infinite's deploy status, GitHub Deployments, a pending claim's proof),
 * at most 20 minutes; a failed merge deployment with nothing later containing it stops at once.
 */
async function waitForDeploy(
  ctx: WizardContext,
  deps: WizardDeps,
  input: {
    mergeSha: string
    productionBranch: string | null
    signals: DeploySignals
    host: string | null
    onProven: (answer: SiteProveResponse) => void
    /** The cloud answered `none`: it holds no pending claim for this workspace any more. */
    onGone: () => void
  }
): Promise<DeployOutcome> {
  const { mergeSha, signals } = input
  const started = deps.clock.now().getTime()
  const say = waitLines(ctx, deps)
  let lastClaimPoll = -Infinity
  let claimLive = signals.claim
  let unavailableReason: string | undefined
  ctx.emit.emit("step.sub", { step: "prove", text: `Waiting for the deploy of ${mergeSha.slice(0, 7)}…`, tone: "pending" })
  for (;;) {
    let githubLive = signals.github !== null
    if (signals.infinite) {
      const result = await mergeIsDeployed(deps, mergeSha, input.productionBranch)
      if (result.deployed) return result
    }
    if (signals.github) {
      const read = await githubDeployRead(deps, signals.github, mergeSha, input.productionBranch)
      if ("deployed" in read) return read
      if ("failed" in read) return { deployed: false, why: "failed", reason: read.reason, blocked: read.blocked }
      if ("unavailable" in read) {
        githubLive = false
        if (unavailableReason !== read.reason) ctx.emit.emit("step.sub", { step: "prove", text: read.reason, tone: "warn" })
        unavailableReason = read.reason
      } else {
        say(read.waiting === "building" ? `GitHub: Vercel is building ${mergeSha.slice(0, 7)}…` : `GitHub shows no production deployment for ${mergeSha.slice(0, 7)} yet`)
      }
    }
    const now = deps.clock.now().getTime()
    if (claimLive && now - lastClaimPoll >= PROVE_LIMITS.claimPollMs) {
      lastClaimPoll = now
      const answer = await proveOnce(ctx, deps)
      if (answer?.state === "proven") {
        input.onProven(answer)
        // The file exists only in this run's merge: the cloud reading it IS the deploy (`site_file`).
        if (await mergeBroughtProofFile(ctx, deps, mergeSha, input.productionBranch)) return { deployed: true, sha: mergeSha, how: "site_file" }
        // The file was already served before this merge: the proof stands, but it does not show this deploy.
        claimLive = false
        ctx.emit.emit("step.sub", {
          step: "prove",
          text: `The proof file was already on ${input.host ?? "your site"} before this merge, so it does not show that ${mergeSha.slice(0, 7)} deployed`,
          tone: "info"
        })
        if (!signals.infinite && !githubLive) return { deployed: false, why: "no_signal", reason: unavailableReason }
      } else if (answer?.state === "none") {
        // Review P1-1: the claim is gone (expired, or another source took the site); waiting on it can never prove.
        claimLive = false
        input.onGone()
        if (!signals.infinite && !githubLive) return { deployed: false, why: "claim_gone" }
      } else if (input.host) say(`Checking ${input.host}/.well-known/infinite-site-verification.txt…`)
    }
    if (!signals.infinite && !githubLive && !claimLive) return { deployed: false, why: "no_signal", reason: unavailableReason }
    if (deps.clock.now().getTime() - started >= PROVE_LIMITS.deployWaitMs) return { deployed: false, why: "timeout" }
    await deps.clock.sleep(PROVE_LIMITS.deployPollMs, ctx.signal)
  }
}

/** §3y.4: a deployed site whose claim is still pending is re-asked for up to 3 minutes (a CDN may lag). */
async function proveAfterDeploy(
  ctx: WizardContext,
  deps: WizardDeps,
  onProven: (answer: SiteProveResponse) => void
): Promise<{ proven: true } | { proven: false; outcome: ProveOutcome | null; gone?: true }> {
  const started = deps.clock.now().getTime()
  let outcome: ProveOutcome | null = null
  for (;;) {
    const answer = await proveOnce(ctx, deps)
    if (answer?.state === "proven") {
      onProven(answer)
      return { proven: true }
    }
    // Review P1-1: `none` = the cloud holds no pending claim any more; asking again cannot prove it.
    if (answer?.state === "none") return { proven: false, outcome, gone: true }
    outcome = answer?.hosts.find((entry) => entry.outcome !== "proven")?.outcome ?? outcome
    if (deps.clock.now().getTime() - started + PROVE_LIMITS.claimGracePollMs > PROVE_LIMITS.claimGraceMs) return { proven: false, outcome }
    await deps.clock.sleep(PROVE_LIMITS.claimGracePollMs, ctx.signal)
  }
}

/**
 * §3y.4 / P2-7: the report's `columns.proven_live.pending` when this run has no proven column: `deploy` only while
 * Infinite itself can observe the deploy (a hosting connection, or a pending claim the cloud checks);
 * `open_infinite` while a deployed claim awaits the cloud (or `--no-prove` hands the proof to the app);
 * `rerun_tag` when nothing in Infinite can observe it.
 */
export function provenPendingFor(input: {
  state: Pick<WizardRunState, "report" | "site" | "steps">
  hostingVercel: boolean
  noProve: boolean
  /** The run's production host as `resolveProductionHost` reads it; null = none known (the app cannot visit). */
  productionHost?: string | null
}): "deploy" | "open_infinite" | "rerun_tag" | null {
  const column = input.state.report.proven_live
  if (column) {
    // R2-2: a proven column that measured something is the answer; one that measured nothing says who finishes it
    // through its own unmeasured cells (set by `prove`): pending_open_infinite only while the app is proving it.
    if (provenColumnHasEvidence(column)) return null
    const reason = column.finishLine.proof_from_real_visit?.reason
    return reason === "pending_open_infinite" ? "open_infinite" : reason === "pending_deploy" ? "deploy" : "rerun_tag"
  }
  // R2-4: with no production host the app has nothing to visit, whatever else it can observe.
  if (input.productionHost === null) return "rerun_tag"
  if (input.state.steps.prove?.code === "INF_WIZ_HOST_UNCONFIRMED") return "open_infinite"
  const observable = input.hostingVercel || input.state.site?.claim?.state === "pending_proof"
  if (!observable) return "rerun_tag"
  return input.noProve ? "open_infinite" : "deploy"
}

/** DECISIONS §1.4 outcome words for a host that is not confirmed yet. */
export const PROVE_OUTCOME_WORDS: Record<Exclude<ProveOutcome, "proven">, string> = {
  not_served: "the file is not served yet",
  wrong_token: "the file holds another workspace's token",
  redirects_elsewhere: "the address redirects to another host",
  blocked: "the site's bot protection blocked Infinite's check",
  unreachable: "Infinite could not reach it",
  not_checked: "Infinite has not checked it yet"
}

// ---------------------------------------------------------------------------------------------
// 2. The real visit
// ---------------------------------------------------------------------------------------------

/**
 * §3x.5 (E): the server lane is installed (the site has its secret; the lane state is not `no_secret`). Only then is it
 * probed and its receipt asked for: run 3 probed a lane that did not exist and waited 120 s for a `no_receipt`.
 */
export function serverLaneInstalled(keys: TagKeys): boolean {
  return keys.serverLane.laneState !== "no_secret"
}

async function runRealVisit(
  ctx: WizardContext,
  deps: WizardDeps,
  runId: string,
  productionHost: string,
  keys: TagKeys,
  expect: TestExpect
): Promise<TestResult | { error: string }> {
  const consentRequired = keys.infinite.consentMode === "required" && keys.infinite.consentStorageKey
  const started = await deps.bridge.startTest({
    mode: "real_visit",
    runId,
    productionHost,
    targets: [{ url: `https://${productionHost}/`, label: "home" }],
    expect,
    consentSeed: consentRequired ? { kind: "infinite_runtime_grant", storageKey: keys.infinite.consentStorageKey! } : null,
    ...(serverLaneInstalled(keys) ? { serverLaneProbe: { path: serverLaneProbePathFor(runId) } } : {}),
    deadlineMs: TEST_LIMITS.deadlineMs.real_visit
  })
  const begun = deps.clock.now().getTime()
  let poll: TestRunPollResponse
  for (;;) {
    poll = await deps.bridge.pollTest(started.testRunId, PROVE_LIMITS.testPollWaitSeconds)
    if (poll.state === "done" || poll.state === "failed" || poll.state === "cancelled") break
    if (deps.clock.now().getTime() - begun > PROVE_LIMITS.realVisitClientMs) {
      await deps.bridge.cancelTest(started.testRunId)
      return { error: "the real visit did not finish in time" }
    }
  }
  if (poll.state !== "done" || !poll.result) return { error: poll.error?.message ?? `the real visit ended ${poll.state}` }
  return poll.result
}

/**
 * The markers the receipts read asks the cloud about: ONLY what this visit itself observed. §3x.5: GA4 and the Meta
 * pixel are marked by the connected id when it was seen leaving, else — for a tool with NO connection — by the first
 * id seen leaving, so an installed, unconnected tool still gets its `delivering` receipt from a 2xx (one rule with
 * the desktop's proof watcher).
 */
export function receiptMarkersFrom(result: TestResult, expect: TestExpect): ReceiptMarkers {
  const markers: ReceiptMarkers = {}
  const eventIds = result.markers.infiniteEventIds.slice(0, RECEIPT_LIMITS.maxInfiniteEventIds)
  if (expect.infinite && eventIds.length > 0) markers.infinite = { eventIds }
  if (expect.posthog && result.markers.posthogDistinctId) markers.posthog = { distinctId: result.markers.posthogDistinctId }
  const ga4 = expect.ga4 ? result.ga4.events.find((candidate) => expect.ga4!.includes(candidate.tid)) : result.ga4.events[0]
  if (ga4) {
    const httpStatus = typeof ga4.status === "number" ? ga4.status : null
    markers.ga4 = { measurementId: ga4.tid, seenLeaving: httpStatus !== null && httpStatus >= 200 && httpStatus < 300, httpStatus }
  }
  const tr = expect.meta ? result.meta.tr.find((candidate) => expect.meta!.includes(candidate.pixelId)) : result.meta.tr[0]
  if (tr) {
    const httpStatus = typeof tr.status === "number" ? tr.status : null
    markers.metaPixel = { pixelId: tr.pixelId, seenLeaving: httpStatus !== null && httpStatus >= 200 && httpStatus < 300, httpStatus }
  }
  if (result.serverLaneProbe) markers.serverLane = { probePath: result.serverLaneProbe.path }
  if (result.markers.metaEventIds.length > 0) markers.metaCapi = { metaEventIds: result.markers.metaEventIds }
  return markers
}

// ---------------------------------------------------------------------------------------------
// 3. Receipts
// ---------------------------------------------------------------------------------------------

/**
 * R2-2: the receipts of a run that held the proof claim and made NO visit: nobody visited for this run (the claim
 * keeps the app out), so no receipt can be this run's. Every lane is unknown; nothing is read.
 */
function noVisitReceipts(runId: string, at: string): ReceiptsResponseFields {
  const unknown = { state: "undetermined" as const, receiptAt: null, reason: null, provenance: "cloud_ledger" as const }
  return { runId, phase: "proven_live", checkedAt: at, lanes: Object.fromEntries(RECEIPT_LANES.map((lane) => [lane, { ...unknown }])) as ReceiptsResponseFields["lanes"] }
}

/** The receipt lane each marker asks about. */
const MARKER_LANES: Record<keyof ReceiptMarkers, ReceiptLane> = { infinite: "infinite", posthog: "posthog", ga4: "ga4", metaPixel: "meta_pixel", serverLane: "server_lane", metaCapi: "meta_capi" }

async function readReceipts(ctx: WizardContext, deps: WizardDeps, runId: string, markers: ReceiptMarkers): Promise<ReceiptsResponseFields> {
  const started = deps.clock.now().getTime()
  // §3x.5 (E): only the lanes this run asked about are waited on (a lane with no marker is not this run's to wait for).
  const asked = new Set((Object.keys(markers) as Array<keyof ReceiptMarkers>).map((key) => MARKER_LANES[key]))
  for (;;) {
    const response = await deps.bridge.postReceipts(runId, { phase: "proven_live", markers, waitMs: RECEIPT_LIMITS.defaultWaitMs })
    const pending = (Object.entries(response.lanes) as Array<[ReceiptLane, LaneReceipt]>).some(([lane, receipt]) => asked.has(lane) && receipt.state === "pending")
    if (!pending || deps.clock.now().getTime() - started >= RECEIPT_LIMITS.defaultWaitMs) return response
    await deps.clock.sleep(RECEIPT_LIMITS.pollIntervalMs, ctx.signal)
  }
}

const RECEIPT_TEXT: Record<LaneReceipt["state"], string> = {
  verified: "receipt for this visit",
  delivering: "sent (seen leaving)",
  pending: "no receipt yet",
  no_receipt: "no receipt",
  not_verifiable: "cannot be checked per visit",
  undetermined: "unknown"
}

/** R4-3: fixed words per GA4 realtime reason (a cloud reason is never shown as free text). */
const GA4_REALTIME_WORDS: Record<Ga4RealtimeReason, string> = {
  ga4_realtime_busy: `sent (seen leaving) · GA4 counted other page views in the ${GA4_REALTIME_BEFORE_MINUTES} minutes before this visit, so this visit cannot be singled out`,
  ga4_realtime_none: "sent (seen leaving), but GA4's realtime report counted no page view in the minute of this visit or the next",
  ga4_realtime_unavailable: "sent (seen leaving) · GA4's realtime report could not be read"
}

/**
 * LF4-P1-1: a GA4 realtime receipt, said as exactly what the minute-level report can show (it has no per-visit id). The
 * cloud asks the claim's minute and the next (live-fix 4 round 1: a visit late in its minute lands in the next), so
 * the words name both, never "the minute of this visit" alone.
 */
export const GA4_RECEIVED_WORDS = `received (GA4 counted a page view in the minute of this visit or the next, and none in the ${GA4_REALTIME_BEFORE_MINUTES} minutes before; it has no per-visit id)`

/**
 * R4-3 (live run 4): what a tool's receipt says, in the user's words. A CONNECTED tool is asked: GA4's realtime report
 * ("received") and PostHog's query ("received"); "sent (seen leaving)" is said only of a tool Infinite cannot ask (not
 * connected), or of Meta, which reports only by the hour. Run 4 printed "GA4 · sent (seen leaving)" while GA4 was
 * connected and its realtime report had the visit 10 s later.
 */
export function receiptWords(tool: TestTool, lane: LaneReceipt, connected: boolean): string {
  if (lane.state === "verified") {
    // LF4-P1-1: GA4 realtime is minute-level with no per-visit id; the words say what it counted, never "this visit's".
    if (lane.provenance === "ga4_realtime") return GA4_RECEIVED_WORDS
    if (lane.provenance === "posthog_query") return "received (PostHog has this visit)"
    return RECEIPT_TEXT.verified
  }
  const ga4Reason = (GA4_REALTIME_REASONS as readonly string[]).includes(lane.reason ?? "") ? (lane.reason as Ga4RealtimeReason) : null
  if (tool === "ga4" && ga4Reason !== null && (lane.state === "delivering" || lane.state === "no_receipt")) return GA4_REALTIME_WORDS[ga4Reason]
  if (lane.state === "delivering" && connected && tool === "meta") return "sent (seen leaving) · Meta reports only by the hour, so this visit cannot be confirmed now"
  if (lane.state === "pending" && connected && tool === "ga4") return "not in GA4's realtime report yet"
  return RECEIPT_TEXT[lane.state]
}

// ---------------------------------------------------------------------------------------------
// 4. The column
// ---------------------------------------------------------------------------------------------

const ID_REASONS = new Set(["wrong_id"])
const ONCE_REASONS = new Set(["duplicate_page_view", "no_beacon", "meta_tr_rejected", "traffic_permissions_blocked"])
/** Grader codes that mean "this load could not grade the tool" (its silence proves nothing either way). */
const UNGRADED_CODES = new Set(["automation_detected", "blocked_by_site_bot_rules", "preview_protected", "held_by_consent", "env_dependent", "test_error"])
const NOT_CONNECTED_WORDS = "ID not checked: not connected in Infinite"

/** The beacons a tool sent on a load (GA4 hits, PostHog events, Infinite events, Meta `/tr`). */
function beaconsOf(result: TestResult, tool: TestTool): number {
  return tool === "ga4" ? result.ga4.events.length : tool === "posthog" ? result.posthog.events.length : tool === "infinite" ? result.infinite.events.length : result.meta.tr.length
}

/**
 * §3x.6 (A1) The tools "Proven live" grades: every INSTALLED tool (the census of the merge commit's tree ∪ the tools
 * this run installed), every connected one, and every one the visit saw fire — the rehearsal's `consideredTools` rule.
 * Run 3 graded only connected tools, so its silent Meta pixel and its unconnected GA4 vanished from the column.
 */
export function toolsUnderTest(expect: TestExpect, installed: readonly TestTool[] | null, result: TestResult | null): TestTool[] {
  return TEST_TOOLS.filter((tool) => expect[tool] !== undefined || (installed ?? []).includes(tool) || (result !== null && beaconsOf(result, tool) > 0))
}

/**
 * A lane's receipt as this run's, or not: a "verified" receipt from before the run's server-clock start is
 * never this run's proof (§3z.8 rule 3), so it reads as undetermined with no receipt time.
 */
export function ownReceipt(lane: LaneReceipt, runStartedAt: string | null): LaneReceipt {
  if (lane.state !== "verified" || !lane.receiptAt || runStartedAt === null) return lane
  return Date.parse(lane.receiptAt) < Date.parse(runStartedAt) ? { ...lane, state: "undetermined", receiptAt: null } : lane
}

function receiptFact(lane: LaneReceipt, input: ColumnFact["input"], at: string, label: string, words: string = RECEIPT_TEXT[lane.state]): ColumnFact {
  const fired = lane.state === "verified" || lane.state === "delivering"
  return {
    input,
    state: fired ? "pass" : lane.state === "no_receipt" ? "problem" : "undetermined",
    display: `${label}: ${words}`,
    at,
    ...(lane.state === "verified" && lane.receiptAt ? { receiptAt: lane.receiptAt } : {})
  }
}

/**
 * Fixed words for a T1 check in a report cell (review I1 P1-1). A check's free-text reason (a redirect hop
 * "301 → https://www…", a CSP directive, a %-encoded path) NEVER becomes a cell display: it would break the
 * report's own rules (no arrows, no % without counts) and crash the column after the real visit.
 */
export function t1Words(check: Pick<CheckResult, "checkId" | "state">): string {
  const redirect = check.checkId === "redirect_walk"
  if (check.state === "pass") return redirect ? "campaign tags kept through every redirect" : "the content security policy allows every tool"
  if (check.state === "problem") return redirect ? "a redirect drops campaign tags" : "the content security policy blocks a tool"
  if (check.state === "info") return redirect ? "no redirect on the way in" : "no content security policy"
  return redirect ? "redirects could not be checked" : "the content security policy could not be checked"
}

/** §3x.6 One post-deploy no-send load: graded, or not measured with the reason. */
export type PostDeployLoad =
  | { kind: "graded"; result: TestResult; grades: Record<TestTool, CheckResult> }
  /** `said`: what stopped the load in words (review P1-5: a refused address is said as refused, never a "test error"). */
  | { kind: "none"; reason: Reason; said?: string }

/** P0-2: how the previews check after the deploy reads when the merge's own address needs a Vercel login. */
export const MERGE_ADDRESS_NEEDS_LOGIN = "not tried (the deployment address needs a Vercel login)"

/** Review P1-5: a post-deploy load that returned no result, as what really happened (runDesktopTest's own error). */
export function unloaded(error: string | null, what: string): Extract<PostDeployLoad, { kind: "none" }> {
  if (error === PREVIEW_REFUSED) return { kind: "none", reason: "not_exercised", said: `the Infinite app refused to load ${what}: it could not tie that address to this site` }
  if (error === "busy") return { kind: "none", reason: "not_exercised", said: `${what} was not loaded: the Infinite app's test window was busy` }
  // A bridge code is a fixed snake_case word; the desktop's free-text failure message never becomes a cell display.
  const code = error !== null && /^[a-z][a-z_]{1,39}$/.test(error) ? error : "the test did not finish"
  return { kind: "none", reason: "test_error", said: `${what} could not be loaded (${code})` }
}

export interface ProvenColumnInput {
  jobs?: readonly ChecklistItem[]
  runId: string
  mergeSha: string
  at: string
  keys: TagKeys
  expect: TestExpect
  /**
   * §3x.6 The tools on the DEPLOYED code: the census of the merge commit's tree ∪ the tools this run installed. null =
   * unknown (the merge tree could not be read): only connected and firing tools are graded, and the step says so.
   */
  installed: readonly TestTool[] | null
  /** §3x.6 The three post-deploy measurements; absent = none were made (no visit evidence). */
  postDeploy?: { liveChecks?: CheckResult[]; byteCensus: CheckResult[]; mergePreview: PostDeployLoad; deployedDry: PostDeployLoad }
  /** Null when this run did not do the real visit (the loser of the proof claim, or a re-run). */
  visit: { result: TestResult; grades: Record<TestTool, CheckResult> } | null
  receipts: ReceiptsResponseFields
  t1: CheckResult[]
  serverLaneInstalled: boolean
  /** Agent jobs waiting for a real conversion (they are pending, never "proven" here). */
  conversionsWaiting: number
  /** The run's server-clock start (`runs.start`); null when this state file predates it. */
  runStartedAt?: string | null
  /**
   * How a cell with no reading reads when this run has no real-visit facts (§3y.4, R2-4): `pending_open_infinite`
   * only while Infinite really finishes the live check (the app is proving this run); otherwise "—" `not_exercised`
   * (the report's `pending` is then `rerun_tag`). Default: "—" `not_exercised` (never a promise nobody keeps).
   */
  unmeasured?: { reason: Reason; state: "pending" | "not_measured" }
}

/** A receipt that shows the tool fired on the live site (verified or seen leaving). */
function laneFired(lane: LaneReceipt): boolean {
  return lane.state === "verified" || lane.state === "delivering"
}

/**
 * R2-2 (live run 2): "Proven live" counts a pass or a problem ONLY from this run's real-visit facts or its own
 * receipts. A column with neither measured nothing: no finish-line cell there is a pass or a problem.
 */
export function provenColumnHasEvidence(column: ReportColumnSnapshot): boolean {
  return Object.values(column.finishLine).some((cell) => cell?.state === "pass" || cell?.state === "problem")
}

/** The `proven_live` column, from typed inputs only (receipts, graded facts, cloud reads). */
export function buildProvenColumn(input: ProvenColumnInput): ReportColumnSnapshot {
  const { at, expect, visit } = input
  const runStartedAt = input.runStartedAt ?? null
  // §3z.8 rule 3: only receipts from after this run started are this run's.
  const receipts: ReceiptsResponseFields = {
    ...input.receipts,
    lanes: Object.fromEntries(Object.entries(input.receipts.lanes).map(([lane, receipt]) => [lane, ownReceipt(receipt, runStartedAt)])) as ReceiptsResponseFields["lanes"]
  }
  const facts: ColumnFact[] = []
  const tools = toolsUnderTest(expect, input.installed, visit?.result ?? null)
  const unmeasured = input.unmeasured ?? { reason: "not_exercised" as Reason, state: "not_measured" as const }
  // R2-2: no real visit and no receipt of this run → nothing on the live site was measured. The column then holds
  // no fact at all: not the consent setting (no visit measured it), not a T1 read, not a missing receipt.
  const evidence = visit !== null || Object.values(receipts.lanes).some(laneFired)
  if (!evidence) return unmeasuredProvenColumn(input, receipts, unmeasured)

  if (visit) {
    for (const tool of tools) {
      const grade = visit.grades[tool]
      if (!grade) continue
      const reason = gradeReasonCode(grade)
      if (grade.state === "info") continue // not installed, nothing fired: not graded live
      // §3x.6 (A2) The ONCE half: a tool that fired cleanly but has no connection DOES fire once (the grader's
      // `not_connected` comes after its duplicate, PII and silence rules); only its ID cannot be compared.
      const notConnected = grade.state === "undetermined" && reason === "not_connected"
      const once: ColumnFact["state"] =
        grade.state === "pass" || notConnected ? "pass" : grade.state === "problem" ? (ONCE_REASONS.has(reason) ? "problem" : "undetermined") : "undetermined"
      facts.push({
        input: "real_visit.graded",
        state: once,
        display: notConnected ? `${TOOL_LABELS[tool]}: fires once (${NOT_CONNECTED_WORDS})` : `${TOOL_LABELS[tool]}: ${gradeWords(grade, null)}`,
        at,
        checkId: grade.checkId,
        ...(once === "undetermined" ? { reason: reportReason(reason) } : {})
      })
      // The IDS half: pass / wrong_id / undetermined (not_connected, or why it could not be graded).
      const ids: ColumnFact["state"] = grade.state === "pass" ? "pass" : grade.state === "problem" && ID_REASONS.has(reason) ? "problem" : "undetermined"
      facts.push({
        input: "real_visit.ids_vs_keys",
        state: ids,
        display: `${TOOL_LABELS[tool]}: ${ids === "pass" ? "the connected ID" : ids === "problem" ? "an ID that is not the connection's" : notConnected ? NOT_CONNECTED_WORDS : "not determinable"}`,
        at,
        checkId: grade.checkId,
        ...(ids === "undetermined" ? { reason: notConnected ? "not_connected" : reportReason(reason) } : {})
      })
    }
    const piiFlagged = Object.values(visit.grades).some((grade) => grade.state === "problem" && gradeReasonCode(grade) === "no_pii")
    const piiCount = visit.result.pii.reduce((sum, item) => sum + item.count, 0)
    facts.push({
      input: "real_visit.pii",
      state: piiFlagged || piiCount > 0 ? "problem" : "pass",
      display: piiFlagged || piiCount > 0 ? "personal data seen in a request" : "no personal data in any request",
      at
    })
    const violations = visit.result.csp.violations.length
    facts.push({ input: "real_visit.csp", state: violations > 0 ? "problem" : "pass", display: violations > 0 ? `${violations} CSP violation(s)` : "no CSP violation", at })
  }

  for (const result of input.t1) {
    if (result.checkId === "csp_header" || result.checkId === "csp") {
      facts.push({ input: "t1.csp", state: result.state, at: result.at, checkId: result.checkId, display: t1Words(result) })
    } else if (result.checkId === "redirect_walk") {
      facts.push({ input: "t1.redirect_walk", state: result.state, at: result.at, checkId: result.checkId, display: t1Words(result) })
    }
  }
  if (input.postDeploy) facts.push(...postDeployFacts(input.postDeploy, input.installed, expect, at, input.jobs))

  // §3x.6 Receipts, per tool under test: a beacon with a receipt, a receipt problem, or an installed tool that sent
  // NOTHING (the cloud cannot know it is installed, so only the visit can say it was silent; run 3's Meta pixel).
  for (const tool of tools) facts.push(toolReceiptFact(tool, visit, receipts.lanes[TOOL_LANES[tool]], input, at))
  const proofLanes: Array<[ReceiptLane, string]> = tools.map((tool) => [TOOL_LANES[tool], TOOL_LABELS[tool]])
  if (input.serverLaneInstalled) {
    proofLanes.push(["server_lane", "Server lane"])
    facts.push(receiptFact(receipts.lanes.server_lane, "receipts.per_tool", at, "Server lane"))
  }
  if (expect.posthog) {
    const lane = receipts.lanes.posthog
    const viaProxy = posthogViaProxy(visit)
    const fact = receiptFact(lane, "receipts.posthog", at, "PostHog")
    // No receipt because the grader could not grade PostHog on the visit (the site's banner held it): unknown, not a problem.
    if (fact.state === "problem" && visit !== null && viaProxy === null && ungradedOn(visit, "posthog")) {
      facts.push({ ...fact, state: "undetermined", display: "PostHog: route not observed by this run", reason: reportReason(gradeReasonCode(visit.grades.posthog)) })
    } else if (fact.state === "pass" && viaProxy === false) facts.push({ ...fact, state: "problem", display: "PostHog: sent directly (ad blockers drop it)" })
    else if (fact.state === "pass" && viaProxy === null) facts.push({ ...fact, state: "undetermined", display: "PostHog: route not observed by this run" })
    else facts.push(fact)
  }
  if (input.serverLaneInstalled) facts.push(receiptFact(receipts.lanes.server_lane, "receipts.server_lane", at, "Server lane"))

  facts.push({
    input: "keys.consent_mode",
    state: "info",
    display: input.keys.infinite.consentMode ? consentWords(input.keys.infinite.consentMode) : "not recorded",
    at
  })

  // Rows.
  const rows: Parameters<typeof buildColumn>[1]["rows"] = {}
  rows.consent_setting = input.keys.infinite.consentMode
    ? { value: input.keys.infinite.consentMode, display: consentWords(input.keys.infinite.consentMode), state: "info", source: "cloud_read", at }
    : { value: "not recorded", display: "not recorded", state: "info", source: "cloud_read", at }
  rows.preview_share = { value: null, state: "not_measured", source: "cloud_read", at, reason: "needs_7_days" }
  rows.ga4_key_events = { value: null, state: "pending", source: "cloud_read", at, reason: "needs_7_days" }
  rows.server_conversions = serverConversionsRow(input, at)
  rows.live_test_per_tool = liveTestRow(proofLanes, receipts, at)
  if (visit) {
    rows.ga4_page_views_per_visit = ga4PageViewsRow(visit, expect, input.installed, at, receipts.lanes.ga4)
    rows.meta_pixel = metaPixelRow(visit, expect, input.installed, at)
  } else {
    rows.ga4_page_views_per_visit = { value: null, state: "pending", source: "desktop_test", at, reason: "pending_open_infinite" }
    rows.meta_pixel = { value: null, state: "pending", source: "desktop_test", at, reason: "pending_open_infinite" }
  }
  rows.posthog_route = posthogRouteRow(receipts.lanes.posthog, visit, expect, at)

  return buildColumn("proven_live", {
    runId: input.runId,
    meta: { measuredAt: at, sha: input.mergeSha },
    facts,
    rows,
    runStartedAt,
    ...(visit ? {} : { unmeasured })
  })
}

/**
 * The "Conversions sent from the server" cell after the deploy. While the site has no server-event secret yet, the
 * owner's setup steps are undone and nothing can arrive: it says so, never "waits for a real conversion".
 */
function serverConversionsRow(input: Pick<ProvenColumnInput, "conversionsWaiting" | "keys">, at: string): RowCellInput {
  if (input.conversionsWaiting <= 0) return { value: null, state: "not_measured", source: "wizard_check", at, reason: "not_exercised" }
  const setUp = input.keys.serverLane?.laneState !== undefined && input.keys.serverLane.laneState !== "no_secret"
  return { value: "waiting", display: setUp ? `${input.conversionsWaiting} wired · waits for a real conversion` : `${input.conversionsWaiting} wired · sends nothing until you do the setup steps`, state: "pending", source: "wizard_check", at }
}

/**
 * R2-2: the column when nothing on the live site was measured. `measuredAt` stays null (the headline then says "not
 * checked live yet" with the reason), every cell is "—" with the run's unmeasured reason, and only the by-design
 * pending cells (a real conversion, the day-7 key events) keep their own reasons. Never a pass, never a problem.
 */
function unmeasuredProvenColumn(input: ProvenColumnInput, receipts: ReceiptsResponseFields, unmeasured: NonNullable<ProvenColumnInput["unmeasured"]>): ReportColumnSnapshot {
  const { at, expect } = input
  const dash = (source: RowCellInput["source"]): RowCellInput => ({ value: null, state: unmeasured.state, source, at, reason: unmeasured.reason })
  const tools = toolsUnderTest(expect, input.installed, null)
  const rows: Parameters<typeof buildColumn>[1]["rows"] = {
    consent_setting: dash("cloud_read"),
    preview_share: { value: null, state: "not_measured", source: "cloud_read", at, reason: "needs_7_days" },
    ga4_key_events: { value: null, state: "pending", source: "cloud_read", at, reason: "needs_7_days" },
    server_conversions: serverConversionsRow(input, at),
    live_test_per_tool:
      tools.length === 0 && !input.serverLaneInstalled ? { value: null, state: "not_measured", source: "cloud_receipt", at, reason: "not_connected" } : dash("cloud_receipt"),
    ga4_page_views_per_visit: expect.ga4 ? dash("desktop_test") : { value: null, state: "not_measured", source: "desktop_test", at, reason: "not_connected" },
    meta_pixel: expect.meta ? dash("desktop_test") : { value: null, state: "not_measured", source: "desktop_test", at, reason: "not_connected" },
    posthog_route: expect.posthog ? dash("cloud_receipt") : { value: null, state: "not_measured", source: "cloud_receipt", at, reason: "not_connected" }
  }
  void receipts
  return buildColumn("proven_live", {
    runId: input.runId,
    meta: { measuredAt: null, sha: input.mergeSha },
    facts: [],
    rows,
    runStartedAt: input.runStartedAt ?? null,
    unmeasured,
    builtAt: at
  })
}

/** The grader could not grade `tool` on the visit (held by consent, a bot-flagged window, a test error). */
function ungradedOn(visit: NonNullable<ProvenColumnInput["visit"]>, tool: TestTool): boolean {
  const grade = visit.grades[tool]
  return grade !== undefined && grade.state === "undetermined" && UNGRADED_CODES.has(gradeReasonCode(grade))
}

/** Words for a receipt the cloud refused because the row lacked Infinite's test mark (§3x.5). */
const UNMARKED_WORDS = "landed without the test mark (counted as a person)"

/**
 * §3x.6 One tool's `receipts.per_tool` reading: verified / delivering → pass; `no_receipt` → problem (an `unmarked:`
 * one says it landed as a person); an installed tool the visit saw NO beacon from → problem "sent nothing" (unless the
 * grader could not grade it there); a fired tool with no connection → undetermined `not_connected`; pending → pending.
 */
function toolReceiptFact(tool: TestTool, visit: ProvenColumnInput["visit"], lane: LaneReceipt, input: ProvenColumnInput, at: string): ColumnFact {
  const label = TOOL_LABELS[tool]
  const installed = (input.installed ?? []).includes(tool)
  const fired = visit !== null && beaconsOf(visit.result, tool) > 0
  if (visit !== null && !fired && installed) {
    if (ungradedOn(visit, tool)) {
      const reason = reportReason(gradeReasonCode(visit.grades[tool]))
      return { input: "receipts.per_tool", state: "undetermined", display: `${label}: ${reason === "held_by_consent" ? "not measured, kept off by your cookie banner" : "could not be graded on the real visit"}`, at, reason }
    }
    return { input: "receipts.per_tool", state: "problem", display: `${label}: sent nothing`, at }
  }
  if (lane.state === "no_receipt" && (lane.reason ?? "").startsWith("unmarked:")) return { input: "receipts.per_tool", state: "problem", display: `${label}: ${UNMARKED_WORDS}`, at }
  if (lane.state === "not_verifiable" && input.expect[tool] === undefined && fired) {
    return { input: "receipts.per_tool", state: "undetermined", display: `${label}: fires (${NOT_CONNECTED_WORDS})`, at, reason: "not_connected" }
  }
  const connected = input.expect[tool] !== undefined
  if (lane.state === "pending") return { input: "receipts.per_tool", state: "pending", display: `${label}: ${receiptWords(tool, lane, connected)}`, at }
  return receiptFact(lane, "receipts.per_tool", at, label, receiptWords(tool, lane, connected))
}

/** §3x.6 The post-deploy measurements as facts: production's own bytes, the merge's own deployment, a page change. */
function postDeployFacts(post: NonNullable<ProvenColumnInput["postDeploy"]>, installed: readonly TestTool[] | null, expect: TestExpect, at: string, jobs?: readonly ChecklistItem[]): ColumnFact[] {
  const facts: ColumnFact[] = []
  for (const check of post.byteCensus.filter((entry) => entry.checkId === "byte_census")) {
    facts.push({
      input: "t1.byte_census",
      state: check.state === "info" ? "pass" : check.state,
      display: check.state === "problem" ? "duplicate tags on the live page" : check.state === "pass" || check.state === "info" ? "each tool set up once on the live page" : "the live page's tags could not be read",
      at: check.at,
      checkId: check.checkId
    })
  }
  const leftPreview = withheldPreviewTools(jobs)
  if (post.mergePreview.kind === "none" && post.mergePreview.reason === "preview_protected") {
    // P0-2: an address behind a login was not tried: said as such, never "unknown".
    facts.push({ input: "merge_preview.graded", state: "info", display: MERGE_ADDRESS_NEEDS_LOGIN, at, reason: "preview_protected" })
  } else if (post.mergePreview.kind === "none") {
    facts.push({ input: "merge_preview.graded", state: "undetermined", display: post.mergePreview.said ?? "the merge's own deployment address was not loaded", at, reason: post.mergePreview.reason })
  } else {
    const scoped = leftPreview.length ? previewScope(post.mergePreview.grades, leftPreview) : null
    if (scoped && (scoped.state === "pass" || scoped.state === "info")) facts.push({ input: "merge_preview.graded", state: "info", display: scoped.note, at, checkId: "preview_self_silent" })
    for (const tool of ["ga4", "posthog", "meta"] as const) {
      if (leftPreview.includes(tool) || (scoped && (scoped.state === "pass" || scoped.state === "info"))) continue
      const grade = post.mergePreview.grades[tool]
      if (!grade || grade.state === "info") continue
      const code = gradeReasonCode(grade)
      const state: ColumnFact["state"] = grade.state === "pass" ? "pass" : grade.state === "problem" && code === "previews_send_data" ? "problem" : "undetermined"
      facts.push({
        input: "merge_preview.graded",
        state,
        display: `${TOOL_LABELS[tool]}: ${state === "pass" ? "silent on the merge's own deployment address" : state === "problem" ? "sends from the merge's own deployment address" : "could not be graded there"}`,
        at,
        checkId: grade.checkId,
        ...(state === "undetermined" ? { reason: reportReason(code) } : {})
      })
    }
  }
  if (post.deployedDry.kind === "none") {
    facts.push({ input: "deployed_dry.spa_navigation", state: "undetermined", display: post.deployedDry.said ?? "no page change was measured after the deploy", at, reason: post.deployedDry.reason })
  } else {
    facts.push(...spaFacts(post.deployedDry.result, post.deployedDry.grades, installed, expect, at))
  }
  return facts
}

/** §3x.6 One page view per client-side navigation, per tool, from a no-send load of production that navigated once. */
function spaFacts(result: TestResult, grades: Record<TestTool, CheckResult>, installed: readonly TestTool[] | null, expect: TestExpect, at: string): ColumnFact[] {
  const navigated = result.ga4.events.some((event) => event.afterNav) || result.posthog.events.some((event) => event.afterNav) || result.meta.tr.some((tr) => tr.afterNav) || result.infinite.events.some((event) => event.nav)
  if (!navigated) return [{ input: "deployed_dry.spa_navigation", state: "undetermined", display: "no page change observed", at, reason: "not_exercised" }]
  const facts: ColumnFact[] = []
  const consider = (tool: TestTool) => expect[tool] !== undefined || (installed ?? []).includes(tool)
  const verdict = (tool: TestTool, after: number, what: string): ColumnFact => {
    const code = gradeReasonCode(grades[tool])
    const state: ColumnFact["state"] = code === "meta_spa_page_view_missing" || after === 0 ? "problem" : after > 1 || code === "duplicate_page_view" ? "problem" : "pass"
    const display = state === "pass" ? `${TOOL_LABELS[tool]}: one ${what} per page change` : after === 0 ? `${TOOL_LABELS[tool]}: misses page changes` : `${TOOL_LABELS[tool]}: counts a page change ${after} times`
    return { input: "deployed_dry.spa_navigation", state, display, at, checkId: `${tool}_spa_page_view` }
  }
  if (consider("ga4") && result.ga4.events.length > 0) facts.push(verdict("ga4", result.ga4.events.filter((event) => event.afterNav && event.en === "page_view").length, "page_view"))
  if (consider("posthog") && result.posthog.events.length > 0) facts.push(verdict("posthog", result.posthog.events.filter((event) => event.afterNav && event.event === "$pageview").length, "$pageview"))
  if (consider("meta") && result.meta.tr.length > 0) facts.push(verdict("meta", result.meta.tr.filter((tr) => tr.afterNav && tr.ev === "PageView").length, "PageView"))
  return facts.length > 0 ? facts : [{ input: "deployed_dry.spa_navigation", state: "undetermined", display: "no tool sent a page view on the page change", at, reason: "not_exercised" }]
}

function consentWords(mode: "not_required" | "required"): string {
  return mode === "required" ? "waits for your banner's yes" : "starts with your site's own analytics, or on page load if it has none"
}

function liveTestRow(lanes: Array<[ReceiptLane, string]>, receipts: ReceiptsResponseFields, at: string): RowCellInput {
  if (lanes.length === 0) return { value: null, state: "not_measured", source: "cloud_receipt", at, reason: "not_connected" }
  const states = lanes.map(([lane]) => receipts.lanes[lane])
  // "verified" is said only of a receipt with its time (§3i.3 rule 3); one without counts as seen.
  const verified = states.filter((lane) => lane.state === "verified" && lane.receiptAt)
  const delivering = states.filter((lane) => lane.state === "delivering" || (lane.state === "verified" && !lane.receiptAt)).length
  const fired = verified.length + delivering
  const missing = states.some((lane) => lane.state === "no_receipt")
  const latestReceipt = verified.map((lane) => lane.receiptAt).filter((value): value is string => !!value).sort().at(-1)
  const parts = [`${fired} of ${lanes.length} fire`]
  if (verified.length > 0) parts.push(`${verified.length} verified (receipts from this visit)`)
  if (delivering > 0) parts.push(`${delivering} seen leaving`)
  return {
    value: `${fired} of ${lanes.length}`,
    display: verified.length > 0 ? `${parts[0]}: ${parts.slice(1).join(" · ")}` : parts.join(": "),
    state: fired === lanes.length ? "pass" : missing ? "problem" : "undetermined",
    source: "cloud_receipt",
    at,
    ...(latestReceipt ? { receiptAt: latestReceipt } : {})
  }
}

function ga4PageViewsRow(visit: NonNullable<ProvenColumnInput["visit"]>, expect: TestExpect, installed: readonly TestTool[] | null, at: string, lane: LaneReceipt): RowCellInput {
  // §3x.6: an installed GA4 with no connection is measured too (its ID just cannot be compared).
  if (!expect.ga4) {
    if (!(installed ?? []).includes("ga4") && visit.result.ga4.events.length === 0) return { value: null, state: "not_measured", source: "desktop_test", at, reason: "not_connected" }
    // Silent because the grader could not grade it here (the site's banner held it, a bot-flagged window): unknown.
    if (visit.result.ga4.events.length === 0 && ungradedOn(visit, "ga4")) return { value: null, state: "undetermined", source: "desktop_test", at, checkId: "ga4_seen_leaving", reason: reportReason(gradeReasonCode(visit.grades.ga4)) }
    const views = visit.result.ga4.events.filter((event) => event.en === "page_view" && !event.afterNav)
    const sent = views.some((event) => typeof event.status === "number" && event.status >= 200 && event.status < 300)
    return {
      value: views.length,
      display: `${views.length}${sent ? " · sent (seen leaving)" : ""} · ${NOT_CONNECTED_WORDS}`,
      state: views.length === 1 ? "pass" : "problem",
      source: "desktop_test",
      at,
      checkId: "ga4_seen_leaving"
    }
  }
  const views = visit.result.ga4.events.filter((event) => event.en === "page_view" && expect.ga4!.includes(event.tid) && !event.afterNav)
  const grade = visit.grades.ga4
  // A tool the grader could not grade (held by consent, a bot-flagged window, …) is UNKNOWN, never a
  // problem: what this visit did not see says nothing about the site.
  if (!grade || grade.state === "undetermined") {
    return { value: null, state: "undetermined", source: "desktop_test", at, checkId: "ga4_seen_leaving", reason: reportReason(gradeReasonCode(grade)) }
  }
  const sent = views.some((event) => typeof event.status === "number" && event.status >= 200 && event.status < 300)
  // R4-3: GA4 is connected, so GA4 itself was asked; its answer is the cell's word (never "seen leaving" over a receipt).
  const received = lane.state === "verified" && lane.provenance === "ga4_realtime" && lane.receiptAt !== null
  const word = received ? " · received" : sent ? ` · ${receiptWords("ga4", lane, true)}` : ""
  return {
    value: views.length,
    display: `${views.length}${word}`,
    state: views.length === 1 ? "pass" : "problem",
    // The count is the visit's own measure; the word is GA4's answer (the receipt is the per-tool fact's).
    source: "desktop_test",
    at,
    checkId: "ga4_seen_leaving"
  }
}

const REASON_SET: ReadonlySet<string> = new Set(REASONS)

/** The grader's reason when the report knows it ("held_by_consent", "automation_detected", …), else "not_exercised". */
function reportReason(reason: string | undefined): Reason {
  return reason && REASON_SET.has(reason) ? (reason as Reason) : "not_exercised"
}

/** True / false when this visit saw PostHog events (same-origin = through the proxy); null when it saw none. */
function posthogViaProxy(visit: ProvenColumnInput["visit"]): boolean | null {
  if (!visit || visit.result.posthog.events.length === 0) return null
  return visit.result.posthog.events.some((event) => event.sameOrigin)
}

function metaPixelRow(visit: NonNullable<ProvenColumnInput["visit"]>, expect: TestExpect, installed: readonly TestTool[] | null, at: string): RowCellInput {
  const blocked = visit.result.meta.console.includes("traffic_permissions_blocked")
  // §3x.6: an installed Meta pixel with no connection is measured too: a 2xx PageView passes; silence is a problem.
  if (!expect.meta) {
    if (!(installed ?? []).includes("meta") && visit.result.meta.tr.length === 0) return { value: null, state: "not_measured", source: "desktop_test", at, reason: "not_connected" }
    if (blocked) return { value: "blocked", display: `blocked on ${visit.result.loads[0]?.finalUrl ? new URL(visit.result.loads[0].finalUrl).host : "the site"}`, state: "problem", source: "desktop_test", at, checkId: "meta_seen_leaving" }
    const pageView = visit.result.meta.tr.some((event) => event.ev === "PageView" && typeof event.status === "number" && event.status >= 200 && event.status < 300)
    if (pageView) return { value: "sending", display: `sending (seen leaving) · ${NOT_CONNECTED_WORDS}`, state: "pass", source: "desktop_test", at, checkId: "meta_seen_leaving" }
    if (visit.result.meta.tr.length === 0 && ungradedOn(visit, "meta")) {
      return { value: null, state: "undetermined", source: "desktop_test", at, checkId: "meta_seen_leaving", reason: reportReason(gradeReasonCode(visit.grades.meta)) }
    }
    return { value: "not seen", display: "no Meta event seen leaving", state: "problem", source: "desktop_test", at, checkId: "meta_seen_leaving" }
  }
  const tr = visit.result.meta.tr.filter((event) => expect.meta!.includes(event.pixelId))
  const sent = tr.some((event) => typeof event.status === "number" && event.status >= 200 && event.status < 300)
  if (blocked) return { value: "blocked", display: `blocked on ${visit.result.loads[0]?.finalUrl ? new URL(visit.result.loads[0].finalUrl).host : "the site"}`, state: "problem", source: "desktop_test", at, checkId: "meta_seen_leaving" }
  if (sent) return { value: "sending", display: "sending · domain allowed", state: "pass", source: "desktop_test", at, checkId: "meta_seen_leaving" }
  if (tr.length === 0 && ungradedOn(visit, "meta")) return { value: null, state: "undetermined", source: "desktop_test", at, checkId: "meta_seen_leaving", reason: reportReason(gradeReasonCode(visit.grades.meta)) }
  return { value: "not seen", display: "no Meta event seen leaving", state: tr.length > 0 ? "problem" : "undetermined", source: "desktop_test", at, checkId: "meta_seen_leaving" }
}

function posthogRouteRow(lane: LaneReceipt, visit: ProvenColumnInput["visit"], expect: TestExpect, at: string): RowCellInput {
  if (!expect.posthog) return { value: null, state: "not_measured", source: "cloud_receipt", at, reason: "not_connected" }
  if (!visit) return { value: null, state: "pending", source: "cloud_receipt", at, reason: "pending_open_infinite" }
  const viaProxy = posthogViaProxy(visit)
  const found = lane.state === "verified"
  // The visit saw no PostHog event: the route is unknown (never "direct").
  if (viaProxy === null) {
    return { value: null, state: "undetermined", source: "cloud_receipt", at, checkId: "posthog_distinct_id_receipt", reason: reportReason(gradeReasonCode(visit.grades.posthog)) }
  }
  const route = viaProxy ? "ingest" : "direct"
  return {
    value: route,
    display: `${route === "ingest" ? "through /ingest" : "direct (ad blockers drop it)"}${found ? " · this visit found" : ""}`,
    state: route === "ingest" ? (found ? "pass" : "undetermined") : "problem",
    source: "cloud_receipt",
    at,
    checkId: "posthog_distinct_id_receipt",
    ...(found && lane.receiptAt ? { receiptAt: lane.receiptAt } : {})
  }
}

// ---------------------------------------------------------------------------------------------
// This run's own claim and visit (kept so a resume can finish what it started)
// ---------------------------------------------------------------------------------------------

export const PROVE_VISIT_SCHEMA = "infinite-tag.prove-visit.v1" as const
/** Gitignored with the rest of `.infinite/wizard/`; 0600. */
export const PROVE_VISIT_PATH = `${WIZARD_PATHS.dir}/prove-visit.json`

/**
 * Written when THIS process wins the proof claim, and again with the visit's facts once the visit is
 * graded. A resume that meets its own claim (409 `proving`) then finishes it (column + PATCH) instead of
 * taking it for the Infinite app's and leaving the run `proving` forever.
 */
export interface ProveVisitRecord {
  schema: typeof PROVE_VISIT_SCHEMA
  runId: string
  mergeSha: string
  claimedAt: string
  visit: { result: TestResult; grades: Record<TestTool, CheckResult> } | null
}

type SavedMarkers = WizardRunState["markers"]["prove"]

function savedProveMarkers(saved: SavedMarkers): boolean {
  return (saved.infiniteEventIds?.length ?? 0) > 0 || !!saved.posthogDistinctId || !!saved.probePath || (saved.metaEventIds?.length ?? 0) > 0
}

function markersFromState(saved: SavedMarkers): ReceiptMarkers {
  const markers: ReceiptMarkers = {}
  if (saved.infiniteEventIds?.length) markers.infinite = { eventIds: saved.infiniteEventIds.slice(0, RECEIPT_LIMITS.maxInfiniteEventIds) }
  if (saved.posthogDistinctId) markers.posthog = { distinctId: saved.posthogDistinctId }
  if (saved.probePath) markers.serverLane = { probePath: saved.probePath }
  if (saved.metaEventIds?.length) markers.metaCapi = { metaEventIds: saved.metaEventIds }
  return markers
}

async function readOwnClaim(ctx: WizardContext, deps: WizardDeps, runId: string, mergeSha: string): Promise<ProveVisitRecord | null> {
  const text = await deps.fs.readText(join(ctx.root, PROVE_VISIT_PATH))
  if (text === null) return null
  try {
    const record = JSON.parse(text) as ProveVisitRecord
    return record.schema === PROVE_VISIT_SCHEMA && record.runId === runId && record.mergeSha === mergeSha ? record : null
  } catch {
    return null
  }
}

async function writeOwnClaim(ctx: WizardContext, deps: WizardDeps, record: ProveVisitRecord): Promise<void> {
  await deps.fs.writeTextAtomic(join(ctx.root, PROVE_VISIT_PATH), `${JSON.stringify(record)}\n`, 0o600)
}

// ---------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------


async function runProve(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
  if ((await loadPlanApprovals(ctx, deps))?.ownerWiring?.canWire === false) return { kind: "skipped", reason: "Infinite’s tag was NOT installed by this run. Add the owner wiring before testing it live." }
  if (ctx.options.noProve) {
    return { kind: "skipped", reason: "--no-prove: the Infinite app proves the site after the deploy and shows it in Site Settings." }
  }
  const state = ctx.state.get()
  const runId = state.runId
  const mergeSha = state.pr?.mergeSha ?? null
  if (!runId) {
    return { kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE", message: "There is no Infinite run to prove (the agent step did not create one).", next: "halt" }
  }
  if (!mergeSha) {
    return { kind: "parked", code: "INF_WIZ_MERGE_PARKED", reason: "Nothing is merged yet, so there is nothing to prove.", resumeHint: "Merge the pull request, then run npx infinite-tag again." }
  }

  const hosting = await deps.bridge.hosting()
  let keys = await deps.bridge.keys()
  const site = state.site ?? null
  // §3y.2: a pending site-file claim (only with an app that can prove it).
  const pendingClaim = site?.claim?.state === "pending_proof" && deps.bridge.has("tag.site-claim.v1") ? site.claim : null
  let expect = testExpectFromKeys(keys, pendingClaim)
  const productionHost = resolveProductionHost({ keys, hosting, site }).host
  const productionBranch = hosting.vercel?.productionBranch ?? state.git?.base ?? null

  // §3y.4: every signal this run can wait on. GitHub counts only when it shows Vercel deploying this repo.
  const reader = deploymentReader(deps.host)
  let github: DeploymentReader | null = null
  if (reader && hosting.provider === "vercel") {
    reader.setPreviewProject?.(hosting.vercel?.projectName ?? null)
    github = reader
  } else if (reader) {
    const vercel = await resolveVercelSignal(ctx, deps, hosting)
    reader.setPreviewProject?.(vercel.projectName)
    if (vercel.signal || (await reader.latestProductionDeployment().catch(() => null)) !== null) github = reader
  }
  const signals: DeploySignals = { infinite: hosting.provider === "vercel", github, claim: pendingClaim !== null }
  let claimProven = false
  let claimGone = false
  const onGone = () => {
    claimGone = true
  }
  const onProven = (answer: SiteProveResponse) => {
    claimProven = true
    const at = deps.clock.now().toISOString()
    ctx.state.update((draft) => {
      if (draft.site?.claim) draft.site.claim = { ...draft.site.claim, state: "proven", provenAt: at }
    })
    ctx.emit.emit("step.sub", { step: "prove", text: `✓ ${answer.siteSource?.productionHosts[0] ?? productionHost ?? "Your domain"} confirmed (Infinite read the proof file)`, tone: "ok" })
  }

  // No way to see the deploy: ONE question instead of a 20-minute wait (never under --yes / --json).
  const askDeployed = async (reason?: string): Promise<Extract<DeployWait, { deployed: true }> | null> => {
    const asked =
      ctx.options.yes || ctx.options.json || ctx.options.nested
        ? false
        : await ctx.ask("confirm", {
            question: `${reason ?? `Infinite can't see when ${productionHost ?? "your site"} deploys (no Vercel connection, no GitHub deployments).`} Is pull request #${state.pr?.number ?? "?"} live on ${productionHost ?? "your site"} now?`,
            defaultYes: false
          })
    return asked === true ? { deployed: true, sha: mergeSha, how: "you_said" } : null
  }
  const cannotSee: StepOutcome = { kind: "parked", code: "INF_WIZ_DEPLOY_TIMEOUT", reason: "Infinite cannot see this site's deploys.", resumeHint: "Run npx infinite-tag again once it's live." }

  // Review P1-1: the cloud no longer holds a pending claim (expired, or another Infinite source took the site). Never
  // "the file is not served yet": that is not what happened.
  const claimGoneOutcome = (): StepOutcome => ({
    kind: "parked",
    code: "INF_WIZ_HOST_UNCONFIRMED",
    reason: `${productionHost ?? pendingClaim?.hosts[0] ?? "Your site"} isn't confirmed: Infinite no longer holds a pending proof for it (it expired, or another Infinite source took the site).`,
    resumeHint: "Check this site in Infinite › Site Settings, then run npx infinite-tag again."
  })

  let deploy: Extract<DeployWait, { deployed: true }>
  if (!signals.infinite && !signals.github && !signals.claim) {
    const said = await askDeployed()
    if (!said) {
      return cannotSee
    }
    deploy = said
  } else {
    const waited = await waitForDeploy(ctx, deps, { mergeSha, productionBranch, signals, host: productionHost, onProven, onGone })
    if (!waited.deployed && waited.why === "claim_gone") {
      return claimGoneOutcome()
    }
    if (!waited.deployed && waited.why === "no_signal") {
      await ctx.state.save()
      const said = await askDeployed(waited.reason)
      if (!said) return waited.reason ? { ...cannotSee, reason: waited.reason, resumeHint: "Check this merge's production deployment in the hosting dashboard, then run npx infinite-tag again once it is live." } : cannotSee
      deploy = said
    } else if (!waited.deployed) {
      if (waited.why === "failed") {
        const scanner = buildScanner(ctx, deps, await runPublicIds(ctx, deps))
        const reason = waited.reason ? safeDisplayText(scanner, waited.reason) : null
        return {
          kind: "parked",
          code: "INF_WIZ_DEPLOY_FAILED",
          reason: reason ? `The deploy of ${mergeSha.slice(0, 7)} ${waited.blocked ? "is blocked" : "failed"}: ${reason}${/[.!?]$/.test(reason) ? "" : "."}` : `The deploy of ${mergeSha.slice(0, 7)} failed (GitHub shows the Vercel production deployment failed).`,
          resumeHint: waited.blocked
            ? "A member of the hosting team must redeploy this merge in the hosting dashboard, or merge a follow-up change to trigger a permitted deployment. Once it is live, run npx infinite-tag again."
            : "Fix it and run npx infinite-tag again."
        }
      }
      return {
        kind: "parked",
        code: "INF_WIZ_DEPLOY_TIMEOUT",
        reason: `The deploy of ${mergeSha.slice(0, 7)} was not seen in ${Math.round(PROVE_LIMITS.deployWaitMs / 60_000)} minutes.`,
        resumeHint: signals.infinite || signals.claim
          ? "Open Infinite: it finishes the proof after the deploy and shows it in Site Settings. Or run npx infinite-tag again later."
          : "Run npx infinite-tag again once it's live."
      }
    } else {
      deploy = waited
    }
  }
  const deployWords: Record<DeployHow, string> = {
    merge_deployment: `✓ Deployed ${mergeSha.slice(0, 7)}`,
    serving_descends: `✓ Deployed (a later commit, ${deploy.sha.slice(0, 7)}, includes it)`,
    github_deployment: `✓ Deployed ${mergeSha.slice(0, 7)} (GitHub deployment)`,
    site_file: `✓ Deployed ${mergeSha.slice(0, 7)} (Infinite read its proof file on ${productionHost ?? "your site"})`,
    you_said: `✓ Pull request #${state.pr?.number ?? "?"} is live (you said)`
  }
  ctx.emit.emit("step.sub", { step: "prove", text: deployWords[deploy.how], tone: "ok" })

  if (pendingClaim && !claimProven) {
    // Deployed, but the cloud has not read the file yet. The run's ONE real visit is NOT spent before the proof
    // (a visit before it can never yield an Infinite receipt); the desktop watcher and the hourly watch finish it.
    if (claimGone) {
      await ctx.state.save()
      return claimGoneOutcome()
    }
    const after = await proveAfterDeploy(ctx, deps, onProven)
    if (!after.proven && after.gone) {
      await ctx.state.save()
      return claimGoneOutcome()
    }
    if (!after.proven) {
      await ctx.state.save()
      const words = after.outcome && after.outcome !== "proven" ? PROVE_OUTCOME_WORDS[after.outcome] : PROVE_OUTCOME_WORDS.not_served
      return {
        kind: "parked",
        code: "INF_WIZ_HOST_UNCONFIRMED",
        reason: `${productionHost ?? pendingClaim.hosts[0]} isn't confirmed yet: ${words} (Infinite looks for /.well-known/infinite-site-verification.txt).`,
        resumeHint: "The Infinite app finishes the proof once it is served; or run npx infinite-tag again."
      }
    }
  }
  if (claimProven) {
    // The source now exists with the reserved key: the keys say so, and `expect` comes from them alone.
    await ctx.state.save()
    keys = await deps.bridge.keys()
    expect = testExpectFromKeys(keys)
  }

  // The claim: only the winner visits. The cloud's claim is one atomic `pending|pending_desktop → proving`;
  // a run the desktop is proving, or one already proven, answers 409 claimed_by_other with its state.
  let won = false
  let claimNote = ""
  // This process's own earlier claim (a resume after Ctrl+C, a sleep or a crash between the visit and
  // the PATCH): the cloud answers 409 to it like to anyone's, so the saved record tells them apart.
  let ownClaim: ProveVisitRecord | null = null
  let patchProofState = false
  let settleDesktop = false
  // R2-4: true only while the Infinite app itself holds this run's proof claim (it then makes the visit).
  let appProving = false
  // Review-2 P3-3: with no production host there is no visit to make, so the proof is never claimed. The run stays
  // unclaimed, which is honest and lets the app tell "no visit" apart from a measured result.
  const noHost = productionHost === null
  if (!noHost) {
    try {
      const claim = await deps.bridge.claimProof(runId, "tag")
      won = claim.granted === true
      if (won) {
        await writeOwnClaim(ctx, deps, { schema: PROVE_VISIT_SCHEMA, runId, mergeSha, claimedAt: deps.clock.now().toISOString(), visit: null })
        patchProofState = true
      }
    } catch (error) {
      if (bridgeErrorCode(error) !== "claimed_by_other") throw error
      const proofState = bridgeErrorState(error)
      ownClaim = await readOwnClaim(ctx, deps, runId, mergeSha)
      // The run state's prove markers are written only by THIS run's winning visit: they prove the claim
      // was ours even when the record is gone (its receipts are then read with those markers).
      if (!ownClaim && savedProveMarkers(state.markers.prove)) {
        ownClaim = { schema: PROVE_VISIT_SCHEMA, runId, mergeSha, claimedAt: "", visit: null }
      }
      // Still `proving` under this run's own claim: the PATCH never landed, so this run sends it now.
      patchProofState = ownClaim !== null && (proofState === "proving" || proofState === null)
      appProving = ownClaim === null && (proofState === "proving" || proofState === null)
      // §3x.6: the app proved the run but could not grade the installed set (`undetermined`): this run grades its
      // stored facts and settles it once (the cloud accepts that from the tag only while the desktop left it so).
      settleDesktop = ownClaim === null && proofState === "undetermined"
      claimNote = ownClaim
        ? "this run's own visit, from before the resume"
        : proofState === "proving" || proofState === null
          ? "the Infinite app is already proving this run"
          : `this run's proof is already ${proofState}`
    }
  }

  let visit: ProvenColumnInput["visit"] = null
  let markers: ReceiptMarkers = {}
  let visitError: string | null = null
  // §3x.6 (A1) The tools on the DEPLOYED code: the census of the merge commit's own tree ∪ what this run installed.
  const deployed = await installedAtMerge(ctx, deps, mergeSha, productionBranch)
  // Review P1-6: the cause is said and carried into THE verdict (at best unconfirmed), never swallowed.
  if (deployed.unknown !== null) ctx.emit.emit("step.sub", { step: "prove", text: `! ${deployed.unknown}: a tool that is installed but sent nothing cannot be named, so this run cannot be called proper`, tone: "warn" })
  const consentMode = state.plan?.answers.consentMode ?? keys.infinite.consentMode
  // The site keeps its trackers behind its own banner: the test window never accepts it, so a silent visit is not measured.
  const siteConsentGate = keepsTrackersBehindBanner({
    census: deployed.census,
    consentMode,
    staticCmp: (await readBeforeFactsFile(deps.fs, ctx.root, ctx.runId).catch(() => null))?.cmpDetected ?? null
  })
  const gradeCtx = (result: TestResult) => ({
    ...gradeContextFrom({
      census: deployed.census ?? EMPTY_CENSUS,
      installed: deployed.installed ?? [],
      consentMode,
      cmpDetected: result.environment.cmpDetected
    }),
    ...(siteConsentGate ? { siteConsentGate: true } : {}),
    now: () => new Date(result.startedAt)
  })
  const installed = deployed.census === null ? null : (gradeCtx(EMPTY_FACTS_FOR_CONTEXT).installedTools ?? [])
  if (ownClaim) {
    ctx.emit.emit("step.sub", { step: "prove", text: `No second visit: ${claimNote}; reading its receipts.`, tone: "info" })
    if (ownClaim.visit) {
      visit = ownClaim.visit
      markers = receiptMarkersFrom(ownClaim.visit.result, expect)
    } else if (savedProveMarkers(state.markers.prove)) {
      markers = markersFromState(state.markers.prove)
    } else {
      visitError = "the real visit was interrupted before its results were saved (no second visit is made)"
    }
  } else if (noHost) {
    visitError = "no production host is known for this site"
  } else if (won) {
    if (!productionHost) {
      visitError = "no production host is known for this site"
    } else {
      ctx.emit.emit("step.sub", { step: "prove", text: `One real test visit to ${productionHost}…`, tone: "pending" })
      const result = await runRealVisit(ctx, deps, runId, productionHost, keys, expect)
      if ("error" in result) visitError = result.error
      else {
        // §3z.12 §3e.7 (B11): the grader always gets the consent mode, the installed tools and whose Meta pixel it is.
        const grades = await deps.checks.gradeTestRun(result, expect, "real_visit", gradeCtx(result))
        for (const [tool, grade] of Object.entries(grades) as Array<[TestTool, CheckResult]>) {
          ctx.emit.emit("check.result", { checkId: grade.checkId, tier: "PV", state: grade.state, ...(grade.reason ? { reason: grade.reason } : {}), runId })
          void tool
        }
        visit = { result, grades }
        markers = receiptMarkersFrom(result, expect)
        await writeOwnClaim(ctx, deps, { schema: PROVE_VISIT_SCHEMA, runId, mergeSha, claimedAt: deps.clock.now().toISOString(), visit })
        ctx.state.update((draft) => {
          draft.markers.prove = {
            infiniteEventIds: result.markers.infiniteEventIds,
            posthogDistinctId: result.markers.posthogDistinctId,
            probePath: result.serverLaneProbe?.path ?? null,
            metaEventIds: result.markers.metaEventIds
          }
        })
        await ctx.state.save()
      }
    }
  } else {
    ctx.emit.emit("step.sub", { step: "prove", text: `No second visit: ${claimNote}; reading its receipts.`, tone: "info" })
    markers = markersFromState(state.markers.prove)
    // §3z.9 (A21): the visit the desktop made for this run is graded HERE (the tag's one grader), from the
    // facts the desktop stored; it never starts a second visit. No stored facts → receipts only.
    const stored = await readStoredFacts(ctx, deps, runId)
    if (stored) {
      const grades = await deps.checks.gradeTestRun(stored, expect, "real_visit", gradeCtx(stored))
      visit = { result: stored, grades }
      markers = receiptMarkersFrom(stored, expect)
    }
  }
  // §3x.5 (E): no lane installed → no probe, no marker, no receipt asked for (and no 120 s wait for it).
  const laneInstalled = serverLaneInstalled(keys)
  if (!laneInstalled) delete markers.serverLane

  // A lane with no marker reads the run's STORED receipt (the app's visit, for a lost claim). With the claim held and
  // no visit made, there is none to read (R2-2).
  const receipts = (won || noHost) && visit === null ? noVisitReceipts(runId, deps.clock.now().toISOString()) : await readReceipts(ctx, deps, runId, markers)
  for (const [lane, receipt] of Object.entries(receipts.lanes) as Array<[ReceiptLane, LaneReceipt]>) {
    if (lane === "server_lane" && !laneInstalled) continue
    ctx.emit.emit("receipt", { lane, state: receipt.state, receiptAt: receipt.receiptAt, runId })
  }
  for (const tool of toolsUnderTest(expect, installed, visit?.result ?? null)) {
    const lane = receipts.lanes[TOOL_LANES[tool]]
    const fired = lane.state === "verified" || lane.state === "delivering"
    const conditional = tool === "infinite" && keys.infinite.consentMode === "required" && !!keys.infinite.consentStorageKey
    ctx.emit.emit("step.sub", { step: "prove", text: conditional && fired ? `· ${TOOL_LABELS[tool]} · receipt under a test grant; waiting on your banner signal (not verified)` : `${fired ? "✓" : "·"} ${TOOL_LABELS[tool]} · ${receiptWords(tool, lane, expect[tool] !== undefined)}`, tone: conditional && fired ? "info" : fired ? "ok" : "warn" })
  }

  // Review I1 P1-1: once this run holds the claim, nothing between here and the PATCH may leave the cloud run
  // `proving` for 24 h. An unexpected error building the column still settles the proof as undetermined.
  let proofState: "proven" | "problem" | "undetermined" | null = null
  let commerce: CommerceProofLine[] = []
  // ONE read of Infinite's record since the merge, shared by the shop-event proof and the passive checks.
  const readBaseline = baselineOnce(ctx, deps, runId, deployedSince(state, deps))
  try {
    // T1 after the deploy (read-only).
    const t1: CheckResult[] = []
    let postDeploy: ProvenColumnInput["postDeploy"]
    if (productionHost) {
      const url = `https://${productionHost}/`
      t1.push(...(await deps.checks.redirectWalk([url])), ...(await deps.checks.csp(url)))
      // §3x.6 the three post-deploy measurements, only once something on the live site was measured.
      if (visit !== null || Object.values(receipts.lanes).some(laneFired)) {
        postDeploy = await measureAfterDeploy(ctx, deps, { runId, mergeSha, productionHost, expect, keys, gradeCtx, reader })
      }
      // Review r3: the shop events the plan promised Meta and Infinite, measured where the engine can, said where not.
      commerce = await commerceProof(ctx, deps, { runId, mergeSha, productionHost, expect, reader, since: deployedSince(state, deps), readBaseline })
    }

    // Live run 6: per-tool grades are not job check ids. Derive the PV checks from this
    // visit's facts, including on resume, and let the registry decide the waiting jobs.
    const visitChecks = visit === null ? [] : await deps.checks.gradeTestRunChecks(visit.result, expect, "real_visit", gradeCtx(visit.result))
    // Fresh production readings also settle the same rehearsal question (routing or duplicate counts).
    const routeChecks = visitChecks.filter(check => ["posthog_via_proxy_once", "one_beacon_per_tool"].includes(check.checkId)).map(check => ({ ...check, tier: "RH" as const }))
    const liveResults = [...t1, ...(postDeploy?.liveChecks ?? []), ...visitChecks, ...routeChecks]
    if ((visit === null || visit.result.runId === runId) && receipts.runId === runId) {
      const receiptFloor = Math.max(
        Date.parse(state.runStartedAt ?? state.createdAt),
        Date.parse(state.steps.merge?.at ?? state.createdAt),
        visit === null ? Number.NEGATIVE_INFINITY : Date.parse(visit.result.startedAt)
      )
      const receiptCheck = (checkId: string, receipt: LaneReceipt, measured: boolean): CheckResult => {
        const fresh = receipt.receiptAt !== null && Date.parse(receipt.receiptAt) >= receiptFloor
        const passed = measured && receipt.state === "verified" && fresh
        return {
          checkId, tier: "PV", runId,
          // A read time can record uncertainty, but can never establish the age of a receipt.
          at: visit?.result.startedAt ?? (passed ? receipt.receiptAt! : receipts.checkedAt),
          state: !measured ? "undetermined" : receipt.state === "no_receipt" ? "problem" : passed ? "pass" : "undetermined",
          reason: !measured ? "this visit has no matching marker"
            : receipt.state !== "verified" ? `receipt ${receipt.state}`
            : !fresh ? "no receipt timestamp for this visit" : "this visit's receipt"
        }
      }
      const posthog = visit === null ? receipts.lanes.posthog : ownReceipt(receipts.lanes.posthog, state.runStartedAt ?? state.createdAt)
      if (visit !== null || posthog.state === "verified") liveResults.push(receiptCheck("posthog_distinct_id_receipt", posthog, Boolean(expect.posthog && (visit === null || markers.posthog?.distinctId))))
      const server = visit === null ? receipts.lanes.server_lane : ownReceipt(receipts.lanes.server_lane, state.runStartedAt ?? state.createdAt)
      if (visit !== null || server.state === "verified") liveResults.push(receiptCheck("server_lane_probe_receipt", server, Boolean(laneInstalled && (visit === null || markers.serverLane?.probePath))))
    }
    const waiting = ctx.state.get().jobs.filter((item) => ["waiting_deploy", "claimed", "done_in_code", "proven"].includes(item.state) && item.checks.some((check) => LIVE_TIERS.includes(check.tier)))
    // Only new production measurements may settle the live checks. Keep rehearsal prerequisites,
    // but RH-only jobs need a new post-deploy measurement too.
    const prepared = waiting.map((item) => ({ ...item,
      state: item.state === "proven" ? "waiting_deploy" as const : item.state,
      checks: item.checks.map((check) => check.tier === "T1" || check.tier === "PV" || (check.tier === "RH" && !item.checks.some((entry) => entry.tier === "T1" || entry.tier === "PV"))
        ? { id: check.id, tier: check.tier, state: "not_run" as const } : check)
    }))
    const updated = deps.registry.apply(prepared, liveResults, runId, { afterDeploy: true, awaitingVisit: appProving && visit === null })
    ctx.state.update((draft) => {
      for (const item of updated) {
        const index = draft.jobs.findIndex((entry) => entry.id === item.id)
        if (index >= 0) draft.jobs[index] = item
      }
    })
    for (const item of updated) {
      const previous = waiting.find((entry) => entry.id === item.id)
      if (item.state !== previous?.state || item.note !== previous?.note) {
        ctx.emit.emit("job.state", { itemId: item.id, state: item.state, by: "wizard", note: item.note ?? "the post-deploy checks' results" })
      }
    }
    await ctx.state.save()

    // §3z.12 §3e.1 (B15): the passive checks read real events AFTER the deploy (baseline since = deploy time).
    await applyPassiveChecks(ctx, deps, runId, deployedSince(state, deps), readBaseline)

    const at = deps.clock.now().toISOString()
    const column = buildProvenColumn({
      jobs: ctx.state.get().jobs,
      runId,
      mergeSha,
      at,
      keys,
      expect,
      installed,
      ...(postDeploy ? { postDeploy } : {}),
      visit,
      receipts,
      t1,
      serverLaneInstalled: laneInstalled,
      runStartedAt: state.runStartedAt ?? null,
      conversionsWaiting: state.jobs.filter((item) => item.jobId === "server_conversions" && ["done_in_code", "waiting_real_event"].includes(item.state)).length,
      // R2-4: "open Infinite" only while the app is proving this run; when this run held the claim (or no host is
      // known), nothing in Infinite finishes the live check, so its cells are "—" and the report says rerun_tag.
      unmeasured: appProving && productionHost ? { reason: "pending_open_infinite", state: "pending" } : { reason: "not_exercised", state: "not_measured" }
    })
    const proof = visit ? proofFactsFromVisit(visit, receipts, installed, expect, laneInstalled, deps.clock.now().toISOString(), deployed.ids, deployed.unknown) : null
    ctx.state.update((draft) => {
      draft.report.proven_live = column
      if (proof) draft.proof = proof
    })
    await ctx.state.save()

    if (patchProofState || ownClaim || settleDesktop) {
      // §3x.6 THE verdict decides the PATCH (properly → proven, problems → problem, else undetermined).
      proofState = visitError ? "undetermined" : await verdictProofState(ctx, deps, runId)
      // §3z.8 (A10): the proofState PATCH names its producer, which holds the claim.
      if (patchProofState) await deps.bridge.patchRun(runId, { proofState }, { producer: "tag" })
      else if (settleDesktop && visit !== null && proofState !== "undetermined") {
        try {
          await deps.bridge.patchRun(runId, { proofState }, { producer: "tag" })
        } catch (error) {
          if (bridgeErrorCode(error) !== "claimed_by_other") throw error
          // Review P2-2: the earlier result may be the app's or another tag run's; say what Infinite holds, not whose.
          const held = bridgeErrorState(error)
          ctx.emit.emit("step.sub", { step: "prove", text: `! Infinite kept the result it already holds for this run${held ? ` (${held})` : ""}; this run's verdict (${proofState}) was not stored`, tone: "warn" })
        }
      }
    }
  } catch (error) {
    if (patchProofState && proofState === null) {
      await deps.bridge.patchRun(runId, { proofState: "undetermined" }, { producer: "tag" }).catch(() => undefined)
    }
    throw error
  }

  // §3x.5 What the customer filters the one normal page view by, per tool that recorded it.
  const filter = ctx.state.get().proof?.filter ?? null
  const distinctId = filter?.posthogDistinctId ?? visit?.result.markers.posthogDistinctId ?? state.markers.prove.posthogDistinctId ?? null
  if (distinctId) ctx.emit.emit("step.sub", { step: "prove", text: `Filter this visitor out in PostHog: distinct_id = ${distinctId}`, tone: "info" })
  if (filter?.ga4ClientId) ctx.emit.emit("step.sub", { step: "prove", text: `Filter this visitor out in GA4: client id ${filter.ga4ClientId}`, tone: "info" })
  if (filter?.metaPageViewAt) ctx.emit.emit("step.sub", { step: "prove", text: `Meta recorded it as one PageView at ${filter.metaPageViewAt.slice(11, 19)}Z`, tone: "info" })

  const lanes = toolsUnderTest(expect, installed, visit?.result ?? null)
  const passed = lanes.filter((tool) => ["verified", "delivering"].includes(receipts.lanes[TOOL_LANES[tool]].state)).length
  if (visitError) {
    return { kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE", message: `The real visit could not run: ${visitError}.`, next: "continue" }
  }
  const tail = won || ownClaim ? "" : " (receipts from the Infinite app's visit)"
  const missingShop = commerce.filter((line) => line.state === "missing").length
  const shop = missingShop > 0 ? ` · ${missingShop} shop event${missingShop === 1 ? "" : "s"} not reaching Meta` : ""
  return { kind: "ok", status: `${passed} of ${lanes.length} tools passed the live test${tail}${proofState === "problem" ? " · problems found" : ""}${shop}` }
}

/**
 * Review r3: the shop-event proof (`prove-commerce.ts`) with this run's inventory and code, each line said as a
 * sub-line. A crash is said as "could not run", never a pass, and never stops the proof.
 */
async function commerceProof(
  ctx: WizardContext,
  deps: WizardDeps,
  input: { runId: string; mergeSha: string; productionHost: string; expect: TestExpect; reader: DeploymentReader | null; since: string | null; readBaseline: () => Promise<BridgeBaseline> }
): Promise<CommerceProofLine[]> {
  let lines: CommerceProofLine[]
  try {
    const before = await readBeforeFactsFile(deps.fs, ctx.root, ctx.runId)
    const inventory = readEventInventory((before as unknown as { eventInventory?: unknown } | null)?.eventInventory)
    let files: ReadonlyMap<string, string> | null = null
    try {
      files = inventory ? loadRepoSnapshot(ctx.root, ctx.appRoot).files : null
    } catch {
      files = null
    }
    lines = await proveCommerce(ctx, deps, { ...input, inventory, files })
  } catch (error) {
    lines = [{ id: "shop_events", state: "not_measured", words: `Meta's shop events: the live check could not run (${errorWords(error)}).` }]
  }
  const mark = { seen: "✓", missing: "!", not_measured: "·" } as const
  const tone = { seen: "ok", missing: "warn", not_measured: "info" } as const
  for (const line of lines) ctx.emit.emit("step.sub", { step: "prove", text: `${mark[line.state]} ${line.words}`, tone: tone[line.state] })
  return lines
}

/** No census entries: the grader then knows only what this run installed. */
const EMPTY_CENSUS: CensusResult = { entries: [], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }
/**
 * The site keeps its trackers off until a visitor accepts its own cookie banner: the tag follows the site's own pixels
 * (the site runs GA4, PostHog or a Meta pixel of its own and Infinite's consent mode is not_required, exactly when the
 * install turns follow mode on), or the scan found a consent tool or banner. The proof visit never accepts a banner
 * (the desktop test engine has no way to; it may only seed Infinite's own key), so on such a site a visit where
 * nothing sent is "not measured", never a failure.
 */
export function keepsTrackersBehindBanner(input: { census: CensusResult | null; consentMode: "required" | "not_required" | null; staticCmp: TestResult["environment"]["cmpDetected"] }): boolean {
  if (input.staticCmp !== null) return true
  const sitePixels = (input.census?.entries ?? []).some((entry) => entry.owner === "adopted" && (entry.tool === "ga4" || entry.tool === "posthog" || entry.tool === "meta"))
  return input.consentMode === "not_required" && sitePixels
}

/** gradeContextFrom reads only the facts' cmpDetected; this stands in when no visit facts exist yet. */
const EMPTY_FACTS_FOR_CONTEXT = { environment: { cmpDetected: null } } as unknown as TestResult

/**
 * §3x.6 (A1) The census of the merge commit's OWN tree (a detached worktree of `mergeSha`, fetched first when it is
 * not here yet) and the tools this run's install recorded. `census: null` = the merge tree could not be read; `unknown`
 * then names why (review P1-6: the cause reaches the verdict and the report, it is never swallowed). An install record
 * that does not parse is named the same way.
 */
export async function installedAtMerge(
  ctx: WizardContext,
  deps: WizardDeps,
  mergeSha: string,
  productionBranch: string | null
): Promise<{ census: CensusResult | null; installed: TestTool[] | null; ids: Partial<Record<TestTool, string[]>>; unknown: string | null }> {
  const receipt = await deps.fs.readText(join(ctx.root, ".infinite/install.json"))
  let installed: TestTool[] | null = null
  const unknown: string[] = []
  try {
    const providers = receipt === null ? [] : ((JSON.parse(receipt) as { providers?: unknown }).providers ?? [])
    installed = (Array.isArray(providers) ? providers : []).filter((tool): tool is TestTool => (TEST_TOOLS as readonly string[]).includes(String(tool)))
  } catch (error) {
    unknown.push(`.infinite/install.json does not parse (${errorWords(error)})`)
  }
  let worktree: { dir: string } | null = null
  try {
    try {
      worktree = await deps.git.worktreeAddDetached(mergeSha)
    } catch (first) {
      // The merge commit is not here yet: fetch the production branch once, then try again (its error is the one said).
      if (!productionBranch) throw first
      await deps.git.remoteBranchSha(productionBranch)
      worktree = await deps.git.worktreeAddDetached(mergeSha)
    }
    const census = await deps.checks.census(worktree.dir, ctx.appRoot)
    const ids: Partial<Record<TestTool, string[]>> = {}
    for (const entry of census.entries) {
      if (entry.tool === "x" || !entry.id) continue
      const tool = entry.tool as TestTool
      ids[tool] = [...new Set([...(ids[tool] ?? []), entry.id])]
    }
    return { census, installed, ids, unknown: unknown.length > 0 ? unknown.join("; ") : null }
  } catch (error) {
    unknown.unshift(`the merge commit ${mergeSha.slice(0, 7)}'s files could not be read (${errorWords(error)})`)
    return { census: null, installed, ids: {}, unknown: unknown.join("; ") }
  } finally {
    if (worktree) await deps.git.worktreeRemove(worktree.dir).catch(() => undefined)
  }
}

/** An error's own words, one line, bounded (a cause the report names). */
function errorWords(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, " ").trim().slice(0, 60) || "no message"
}

/**
 * §3x.6 The three measurements of the deployed site, each a no-send load or a read the tag already knows how to make:
 * production's own bytes (T1 `byte_census`, the duplicate check), the merge's own deployment address (previews), and
 * production with one page change (SPA page views). Nothing is sent by any of them.
 */
async function measureAfterDeploy(
  ctx: WizardContext,
  deps: WizardDeps,
  input: {
    runId: string
    mergeSha: string
    productionHost: string
    expect: TestExpect
    keys: TagKeys
    gradeCtx: (result: TestResult) => ReturnType<typeof gradeContextFrom>
    reader: DeploymentReader | null
  }
): Promise<NonNullable<ProvenColumnInput["postDeploy"]>> {
  const { runId, productionHost, expect } = input
  const home = `https://${productionHost}/`
  const liveChecks = await deps.checks.liveBytes([home], expect)
  const byteCensus = liveChecks.filter((check) => check.checkId === "byte_census")
  const consentSeed =
    input.keys.infinite.consentMode === "required" && input.keys.infinite.consentStorageKey ? { kind: "infinite_runtime_grant" as const, storageKey: input.keys.infinite.consentStorageKey } : null
  const isProd = productionMatcher(productionHost)

  // The merge's OWN deployment address (a `*.vercel.app` the guard silences), from GitHub.
  let mergePreview: PostDeployLoad = { kind: "none", reason: "not_exercised" }
  // Review P3-3: a GitHub failure is said as a failed read, never "not exercised".
  let deploymentUrl: string | null = null
  if (input.reader?.productionDeploymentUrl) {
    try {
      deploymentUrl = await input.reader.productionDeploymentUrl(input.mergeSha)
    } catch (error) {
      const kind = error instanceof GhError ? error.kind : "error"
      mergePreview = { kind: "none", reason: "read_failed", said: `the merge's own deployment address could not be read from GitHub (${kind})` }
      ctx.emit.emit("step.sub", { step: "prove", text: `! The merge's own deployment address could not be read from GitHub (${kind}); previews are not re-checked after the deploy`, tone: "warn" })
    }
  }
  // P0-2: Vercel's login answers the desktop's proof read with a 302 to vercel.com, so the desktop would refuse the
  // address. Asked first, without credentials: a login is said as a login, never as a refusal.
  if (deploymentUrl && !isProd(new URL(deploymentUrl).hostname) && isDeniedHost(new URL(deploymentUrl).hostname) && (await previewNeedsLogin(deps.fetch, deploymentUrl))) {
    mergePreview = { kind: "none", reason: "preview_protected", said: MERGE_ADDRESS_NEEDS_LOGIN }
    ctx.emit.emit("step.sub", { step: "prove", text: "The merge's own deployment address needs a Vercel login, so previews were not loaded after the deploy", tone: "info" })
  } else if (deploymentUrl && !isProd(new URL(deploymentUrl).hostname) && isDeniedHost(new URL(deploymentUrl).hostname)) {
    ctx.emit.emit("step.sub", { step: "prove", text: `Loading the merge's own address ${new URL(deploymentUrl).host} (nothing sent)…`, tone: "pending" })
    const loaded = await runDesktopTest(ctx, deps, "prove", {
      mode: "dry_live",
      runId,
      productionHost,
      targets: [{ url: deploymentUrl, label: "preview_self" }],
      expect,
      consentSeed,
      deadlineMs: TEST_LIMITS.deadlineMs.dry_live
    })
    mergePreview = loaded.result
      ? loaded.result.environment.previewProtected
        ? { kind: "none", reason: "preview_protected" }
        : { kind: "graded", result: loaded.result, grades: await deps.checks.gradeTestRun(loaded.result, expect, "dry_live", input.gradeCtx(loaded.result)) }
      : unloaded(loaded.error, "the merge's own deployment address")
  }

  // Production with one client-side navigation (allowed against production; nothing is sent).
  let deployedDry: PostDeployLoad = { kind: "none", reason: "not_exercised" }
  // The SAME navigation `before` measured (an SPA framework with a page beyond home), so before and after compare.
  const secondPath = (await readBeforeFactsFile(deps.fs, ctx.root, ctx.runId))?.spaNavigation?.path ?? null
  if (secondPath) {
    ctx.emit.emit("step.sub", { step: "prove", text: `A page change on ${productionHost} (nothing sent)…`, tone: "pending" })
    const loaded = await runDesktopTest(ctx, deps, "prove", {
      mode: "dry_live",
      runId,
      productionHost,
      targets: [{ url: home, label: "home" }],
      expect,
      consentSeed,
      spaNavigation: { path: secondPath },
      deadlineMs: TEST_LIMITS.deadlineMs.dry_live
    })
    deployedDry = loaded.result
      ? { kind: "graded", result: loaded.result, grades: await deps.checks.gradeTestRun(loaded.result, expect, "dry_live", { ...input.gradeCtx(loaded.result), spaNavigation: true }) }
      : unloaded(loaded.error, "the page change after the deploy")
  }
  if (mergePreview.kind === "graded") {
    const left = withheldPreviewTools(ctx.state.get().jobs)
    const scoped = left.length ? previewScope(mergePreview.grades, left) : null
    liveChecks.push(...(await deps.checks.gradeTestRunChecks(mergePreview.result, expect, "dry_live", input.gradeCtx(mergePreview.result))).filter(check => check.checkId === "preview_self_silent").map(check => ({ ...check, ...(scoped ? { state: scoped.state, reason: scoped.state === "pass" ? "Non-withheld preview guards were read as silent" : scoped.state === "info" ? scoped.note : scoped.state === "problem" ? "previews_send_data — A non-withheld tool sends from the preview" : "not_exercised — A non-withheld preview tool could not be graded" } : {}), tier: "RH" as const })))
  }
  if (deployedDry.kind === "graded") {
    for (const fact of spaFacts(deployedDry.result, deployedDry.grades, input.gradeCtx(deployedDry.result).installedTools, expect, deployedDry.result.startedAt)) {
      if ((fact.checkId === "ga4_spa_page_view" || fact.checkId === "meta_spa_page_view") && (fact.state === "pass" || fact.state === "problem" || fact.state === "undetermined")) {
        const grade = deployedDry.grades[fact.checkId === "ga4_spa_page_view" ? "ga4" : "meta"]
        const unmeasured = grade.state === "undetermined" && gradeReasonCode(grade) !== "not_connected"
        liveChecks.push({ checkId: fact.checkId, tier: "RH", state: unmeasured ? "undetermined" : fact.state, at: fact.at, runId: deployedDry.result.runId, reason: unmeasured ? grade.reason : fact.display })
      }
    }
  }
  return { liveChecks, byteCensus, mergePreview, deployedDry }
}

/** A host the preview guard silences (`HOST_DENY_V1`). */
function isDeniedHost(host: string): boolean {
  const normalized = normalizeHost(host)
  return HOST_DENY_V1.deny.exact.includes(normalized) || HOST_DENY_V1.deny.suffix.some((suffix) => normalized.length > suffix.length && normalized.endsWith(suffix))
}

/**
 * §3x.6 What the real visit measured of every tool under test, and the ids the customer filters its one normal page
 * view by (§3x.5): written to the run state for THE verdict and the disclosure.
 */
export function proofFactsFromVisit(
  visit: NonNullable<ProvenColumnInput["visit"]>,
  receipts: ReceiptsResponseFields,
  installed: readonly TestTool[] | null,
  expect: TestExpect,
  laneProbed: boolean,
  at: string,
  codeIds: Partial<Record<TestTool, string[]>>,
  installedUnknown: string | null
): RunProofState {
  const result = visit.result
  const tools: VerdictToolFact[] = toolsUnderTest(expect, installed, result).map((tool) => {
    const lane = receipts.lanes[TOOL_LANES[tool]]
    const seen =
      tool === "ga4" ? result.ga4.events.map((event) => event.tid) : tool === "posthog" ? result.posthog.events.map((event) => event.projectKey) : tool === "meta" ? result.meta.tr.map((tr) => tr.pixelId) : result.infinite.events.map((event) => event.siteSourceKey)
    const grade = visit.grades[tool]
    return {
      tool,
      ids: [...new Set([...(codeIds[tool] ?? []), ...seen])],
      connected: expect[tool] !== undefined,
      installed: (installed ?? []).includes(tool),
      fired: beaconsOf(result, tool) > 0,
      ungraded: grade !== undefined && grade.state === "undetermined" && UNGRADED_CODES.has(gradeReasonCode(grade)),
      receipt: lane.state,
      receiptReason: lane.reason ?? null
    }
  })
  const cid = result.ga4.events.find((event) => event.cid !== null && /^[0-9]{1,20}\.[0-9]{1,20}$/.test(event.cid))?.cid ?? null
  const metaPageView = result.meta.tr.some((tr) => tr.ev === "PageView" && typeof tr.status === "number" && tr.status >= 200 && tr.status < 300) ? result.finishedAt : null
  return {
    at,
    tools,
    laneProbed: laneProbed && result.serverLaneProbe !== null,
    infinitePageViews: result.infinite.events.filter((event) => event.eventName === "site_page_view" || event.eventName === "page_view").length,
    filter: { ga4ClientId: cid, posthogDistinctId: result.markers.posthogDistinctId, metaPageViewAt: metaPageView },
    installedUnknown
  }
}

/** §3x.6 The proof state THE verdict gives (the report built from this run's columns and facts). */
async function verdictProofState(ctx: WizardContext, deps: WizardDeps, runId: string): Promise<"proven" | "problem" | "undetermined"> {
  const state = ctx.state.get()
  const report = deps.report.build({
    runId,
    tagVersion: deps.tagVersion,
    site: { repoLabel: ctx.root, productionHost: resolveProductionHost({ keys: null, hosting: null, site: state.site ?? null }).host ?? null },
    columns: state.report,
    provenLivePending: null,
    runStartedAt: state.runStartedAt ?? null,
    day7: null,
    notes: [],
    verdictFacts: await verdictFactsFor(ctx, deps)
  })
  if (!report.verdict) throw new Error("the report built for the proof state carries no verdict")
  return proofStateOf(report.verdict)
}

/** The desktop's stored real-visit facts for this run (A21), or null (no capability, none stored, or a read failure). */
async function readStoredFacts(ctx: WizardContext, deps: WizardDeps, runId: string): Promise<TestResult | null> {
  if (!deps.bridge.has("tag.test-facts.v1")) return null
  try {
    const { result } = await deps.bridge.testFacts(runId, { signal: ctx.signal })
    return result.runId === runId && result.mode === "real_visit" ? result : null
  } catch (error) {
    if (bridgeErrorCode(error) === "not_found" || isTransientBridgeFailure(error)) return null
    throw error
  }
}

/** The earliest moment a "real" event can come from the merged code: the merge step's record (≤ 28 days back). */
function deployedSince(state: Readonly<WizardRunState>, deps: WizardDeps): string | null {
  const at = state.steps.merge?.at ?? null
  if (!at) return null
  const floor = deps.clock.now().getTime() - 27 * 24 * 60 * 60 * 1000
  return Date.parse(at) < floor ? new Date(floor).toISOString() : at
}

/**
 * B15: `first_real_outcome` (job 8: an Infinite conversion or a server-lane outcome since the deploy) and
 * `first_real_conversion` (job 10: a PostHog conversion or a GA4 key event received since the deploy), as
 * P-tier results with THIS run's id, applied through the registry (the one state machine). `first_identify`
 * (job 9) has no v1 source and stays `waiting_real_event`. A failed read leaves them unknown, never 0.
 */
type BridgeBaseline = Awaited<ReturnType<WizardDeps["bridge"]["baseline"]>>

/** One baseline read since `since`, made on first use and shared by every reader of this prove run. */
function baselineOnce(ctx: WizardContext, deps: WizardDeps, runId: string, since: string | null): () => Promise<BridgeBaseline> {
  let read: Promise<BridgeBaseline> | null = null
  return () => {
    if (since === null) return Promise.reject(new Error("the merge time is not known"))
    read ??= deps.bridge.baseline(runId, { since, signal: ctx.signal })
    return read
  }
}

async function applyPassiveChecks(ctx: WizardContext, deps: WizardDeps, runId: string, since: string | null, readBaseline: () => Promise<BridgeBaseline>): Promise<void> {
  const waiting = ctx.state.get().jobs.filter((item) => item.state === "waiting_real_event" && item.checks.some((check) => check.tier === "P"))
  if (waiting.length === 0 || since === null || !deps.bridge.has("tag.baseline.v1")) return
  let baseline: Awaited<ReturnType<WizardDeps["bridge"]["baseline"]>>
  try {
    baseline = await readBaseline()
  } catch (error) {
    if (isTransientBridgeFailure(error) || bridgeErrorCode(error) !== null) return
    throw error
  }
  const at = deps.clock.now().toISOString()
  const results: CheckResult[] = []
  const outcomes = (baseline.conversions.infinite ?? []).some((entry) => entry.count > 0) || (baseline.serverLane.outcomes7d ?? 0) > 0
  const known = baseline.conversions.infinite !== null || baseline.serverLane.outcomes7d !== null
  if (known) results.push({ checkId: "first_real_outcome", tier: "P", state: outcomes ? "pass" : "undetermined", reason: outcomes ? "a real conversion arrived after the deploy" : "waiting_real_event — no real conversion yet", at, runId })
  const posthog = (baseline.posthog.conversions ?? []).some((entry) => entry.count > 0)
  const ga4 = (baseline.ga4.keyEvents ?? []).some((entry) => (entry.received28d ?? 0) > 0)
  const conversionKnown = baseline.posthog.conversions !== null || baseline.ga4.keyEvents !== null
  if (conversionKnown) results.push({ checkId: "first_real_conversion", tier: "P", state: posthog || ga4 ? "pass" : "undetermined", reason: posthog || ga4 ? "a real conversion reached PostHog or GA4 after the deploy" : "waiting_real_event — no real conversion yet", at, runId })
  if (results.length === 0) return
  const updated = deps.registry.apply(waiting, results, runId)
  ctx.state.update((draft) => {
    for (const item of updated) {
      const index = draft.jobs.findIndex((entry) => entry.id === item.id)
      if (index >= 0) draft.jobs[index] = item
    }
  })
  for (const item of updated) if (item.state === "proven") ctx.emit.emit("job.state", { itemId: item.id, state: "proven", by: "wizard", note: "a real event arrived after the deploy" })
  await ctx.state.save()
}

export const step: WizardStep<"prove"> = {
  id: "prove",
  title: WIZARD_STEP_META.prove.title,
  who: [...WIZARD_STEP_META.prove.who],
  learn: WIZARD_STEP_META.prove.learn,
  requiredCapabilities: [...WIZARD_STEP_META.prove.requiredCapabilities],
  // F0's structural step test calls inputHash with an empty context, so a missing state hashes as nulls.
  inputHash: (ctx) => {
    const state = ctx.state?.get()
    return hashOf(["prove", state?.runId ?? null, state?.pr?.mergeSha ?? null])
  },
  async run(ctx, deps) {
    try {
      return await runProve(ctx, deps)
    } catch (error) {
      // §3z.4: a bridge failure the step cannot carry on from is an outcome, never a crash.
      const outcome = bridgeFailureOutcome(error)
      if (outcome) return outcome
      throw error
    }
  }
}
