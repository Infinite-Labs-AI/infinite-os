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
// 3. Receipts (waitMs 120 s, re-polled every 10 s), T1 checks after the deploy, the `proven_live` column,
//    then `PATCH proofState` to the result (winner only).
// 4. Print the run's PostHog distinct id so the user can filter this visitor out.
import { bridgeFailureOutcome, isTransientBridgeFailure } from "../../bridge/outcomes.js"
import { gradeContextFrom } from "../../checks/grade-context.js"
import { createHash } from "node:crypto"
import { join } from "node:path"

import type { TagKeys, TagHosting, TestRunPollResponse } from "../contracts/bridge.js"
import type { StepOutcome, WizardContext, WizardDeps, WizardStep } from "../contracts/deps.js"
import type { CheckResult } from "../contracts/jobs.js"
import { RECEIPT_LIMITS, type LaneReceipt, type ReceiptLane, type ReceiptMarkers, type ReceiptsResponseFields } from "../contracts/receipts.js"
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
import { buildColumn, type ColumnFact, type RowCellInput } from "../report.js"

/** How often the deploy status is read, and how long `prove` waits before parking (the desktop watcher continues). */
export const PROVE_LIMITS = {
  deployPollMs: 15_000,
  deployWaitMs: 20 * 60_000,
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

export type DeployWait = { deployed: true; sha: string; how: "merge_deployment" | "serving_descends" } | { deployed: false }

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
  // The serving commit may be newer than anything this clone has: fetch the production branch first.
  if (productionBranch) await deps.git.remoteBranchSha(productionBranch)
  let descends = false
  try {
    descends = await deps.git.isAncestor(mergeSha, serving)
  } catch {
    // An unknown commit (not fetched yet) is "not yet", never "deployed".
    descends = false
  }
  return descends ? { deployed: true, sha: serving, how: "serving_descends" } : { deployed: false }
}

async function waitForDeploy(ctx: WizardContext, deps: WizardDeps, mergeSha: string, productionBranch: string | null): Promise<DeployWait> {
  const started = deps.clock.now().getTime()
  ctx.emit.emit("step.sub", { step: "prove", text: `Waiting for the deploy of ${mergeSha.slice(0, 7)}…`, tone: "pending" })
  for (;;) {
    const result = await mergeIsDeployed(deps, mergeSha, productionBranch)
    if (result.deployed) return result
    if (deps.clock.now().getTime() - started >= PROVE_LIMITS.deployWaitMs) return { deployed: false }
    await deps.clock.sleep(PROVE_LIMITS.deployPollMs, ctx.signal)
  }
}

// ---------------------------------------------------------------------------------------------
// 2. The real visit
// ---------------------------------------------------------------------------------------------

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
    serverLaneProbe: { path: serverLaneProbePathFor(runId) },
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

/** The markers the receipts read asks the cloud about: ONLY what this visit itself observed. */
export function receiptMarkersFrom(result: TestResult, expect: TestExpect): ReceiptMarkers {
  const markers: ReceiptMarkers = {}
  const eventIds = result.markers.infiniteEventIds.slice(0, RECEIPT_LIMITS.maxInfiniteEventIds)
  if (expect.infinite && eventIds.length > 0) markers.infinite = { eventIds }
  if (expect.posthog && result.markers.posthogDistinctId) markers.posthog = { distinctId: result.markers.posthogDistinctId }
  if (expect.ga4) {
    const event = result.ga4.events.find((candidate) => expect.ga4!.includes(candidate.tid))
    if (event) {
      const httpStatus = typeof event.status === "number" ? event.status : null
      markers.ga4 = { measurementId: event.tid, seenLeaving: httpStatus !== null && httpStatus >= 200 && httpStatus < 300, httpStatus }
    }
  }
  if (expect.meta) {
    const tr = result.meta.tr.find((candidate) => expect.meta!.includes(candidate.pixelId))
    if (tr) {
      const httpStatus = typeof tr.status === "number" ? tr.status : null
      markers.metaPixel = { pixelId: tr.pixelId, seenLeaving: httpStatus !== null && httpStatus >= 200 && httpStatus < 300, httpStatus }
    }
  }
  if (result.serverLaneProbe) markers.serverLane = { probePath: result.serverLaneProbe.path }
  if (result.markers.metaEventIds.length > 0) markers.metaCapi = { metaEventIds: result.markers.metaEventIds }
  return markers
}

// ---------------------------------------------------------------------------------------------
// 3. Receipts
// ---------------------------------------------------------------------------------------------

async function readReceipts(ctx: WizardContext, deps: WizardDeps, runId: string, markers: ReceiptMarkers): Promise<ReceiptsResponseFields> {
  const started = deps.clock.now().getTime()
  for (;;) {
    const response = await deps.bridge.postReceipts(runId, { phase: "proven_live", markers, waitMs: RECEIPT_LIMITS.defaultWaitMs })
    const pending = Object.values(response.lanes).some((lane) => lane.state === "pending")
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

// ---------------------------------------------------------------------------------------------
// 4. The column
// ---------------------------------------------------------------------------------------------

const ID_REASONS = new Set(["wrong_id"])
const ONCE_REASONS = new Set(["duplicate_page_view", "no_beacon", "meta_tr_rejected", "traffic_permissions_blocked"])

function toolsUnderTest(expect: TestExpect): TestTool[] {
  return (["infinite", "ga4", "posthog", "meta"] as const).filter((tool) => expect[tool] !== undefined)
}

function receiptFact(lane: LaneReceipt, input: ColumnFact["input"], at: string, label: string): ColumnFact {
  const fired = lane.state === "verified" || lane.state === "delivering"
  return {
    input,
    state: fired ? "pass" : lane.state === "no_receipt" ? "problem" : "undetermined",
    display: `${label}: ${RECEIPT_TEXT[lane.state]}`,
    at,
    ...(lane.state === "verified" && lane.receiptAt ? { receiptAt: lane.receiptAt } : {})
  }
}

export interface ProvenColumnInput {
  runId: string
  mergeSha: string
  at: string
  keys: TagKeys
  expect: TestExpect
  /** Null when this run did not do the real visit (the loser of the proof claim, or a re-run). */
  visit: { result: TestResult; grades: Record<TestTool, CheckResult> } | null
  receipts: ReceiptsResponseFields
  t1: CheckResult[]
  serverLaneInstalled: boolean
  /** Agent jobs waiting for a real conversion (they are pending, never "proven" here). */
  conversionsWaiting: number
}

/** The `proven_live` column, from typed inputs only (receipts, graded facts, cloud reads). */
export function buildProvenColumn(input: ProvenColumnInput): ReportColumnSnapshot {
  const { at, expect, receipts, visit } = input
  const facts: ColumnFact[] = []
  const tools = toolsUnderTest(expect)

  if (visit) {
    for (const tool of tools) {
      const grade = visit.grades[tool]
      if (!grade) continue
      const reason = grade.reason ?? ""
      const once: ColumnFact["state"] =
        grade.state === "pass" ? "pass" : grade.state === "problem" ? (ONCE_REASONS.has(reason) ? "problem" : "undetermined") : grade.state === "info" ? "info" : "undetermined"
      facts.push({ input: "real_visit.graded", state: once, display: `${TOOL_LABELS[tool]}: ${grade.state === "pass" ? "fires once" : reason || grade.state}`, at, checkId: grade.checkId })
      const ids: ColumnFact["state"] =
        grade.state === "pass" ? "pass" : grade.state === "problem" && ID_REASONS.has(reason) ? "problem" : "undetermined"
      facts.push({ input: "real_visit.ids_vs_keys", state: ids, display: `${TOOL_LABELS[tool]}: ${ids === "pass" ? "the connected ID" : ids === "problem" ? "an ID that is not the connection's" : "not determinable"}`, at, checkId: grade.checkId })
    }
    const piiFlagged = Object.values(visit.grades).some((grade) => grade.state === "problem" && grade.reason === "no_pii")
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
      facts.push({ input: "t1.csp", state: result.state, at: result.at, checkId: result.checkId, ...(result.reason ? { display: result.reason } : {}) })
    } else if (result.checkId === "redirect_walk") {
      facts.push({ input: "t1.redirect_walk", state: result.state, at: result.at, checkId: result.checkId, ...(result.reason ? { display: result.reason } : {}) })
    }
  }

  // Receipts: at least one verified/delivering per installed tool (and the server lane when installed).
  const proofLanes: Array<[ReceiptLane, string]> = tools.map((tool) => [TOOL_LANES[tool], TOOL_LABELS[tool]])
  if (input.serverLaneInstalled) proofLanes.push(["server_lane", "Server lane"])
  for (const [lane, label] of proofLanes) facts.push(receiptFact(receipts.lanes[lane], "receipts.per_tool", at, label))
  if (expect.posthog) {
    const lane = receipts.lanes.posthog
    const viaProxy = posthogViaProxy(visit)
    const fact = receiptFact(lane, "receipts.posthog", at, "PostHog")
    if (fact.state === "pass" && viaProxy === false) facts.push({ ...fact, state: "problem", display: "PostHog: sent directly (ad blockers drop it)" })
    else if (fact.state === "pass" && viaProxy === null) facts.push({ ...fact, state: "undetermined", display: "PostHog: route not observed by this run" })
    else facts.push(fact)
  }
  if (input.serverLaneInstalled) facts.push(receiptFact(receipts.lanes.server_lane, "receipts.server_lane", at, "Server lane"))

  facts.push({
    input: "keys.consent_mode",
    state: input.keys.infinite.consentMode ? "pass" : "problem",
    display: input.keys.infinite.consentMode ? consentWords(input.keys.infinite.consentMode) : "not recorded",
    at
  })

  // Rows.
  const rows: Parameters<typeof buildColumn>[1]["rows"] = {}
  rows.consent_setting = input.keys.infinite.consentMode
    ? { value: input.keys.infinite.consentMode, display: consentWords(input.keys.infinite.consentMode), state: "pass", source: "cloud_read", at }
    : { value: "not recorded", display: "not recorded", state: "problem", source: "cloud_read", at }
  rows.preview_share = { value: null, state: "not_measured", source: "cloud_read", at, reason: "needs_7_days" }
  rows.ga4_key_events = { value: null, state: "pending", source: "cloud_read", at, reason: "needs_7_days" }
  rows.server_conversions =
    input.conversionsWaiting > 0
      ? { value: "waiting", display: `${input.conversionsWaiting} wired · waits for a real conversion`, state: "pending", source: "wizard_check", at }
      : { value: null, state: "not_measured", source: "wizard_check", at, reason: "not_exercised" }
  rows.live_test_per_tool = liveTestRow(proofLanes, receipts, at)
  if (visit) {
    rows.ga4_page_views_per_visit = ga4PageViewsRow(visit, expect, at)
    rows.meta_pixel = metaPixelRow(visit, expect, at)
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
    ...(visit ? {} : { unmeasured: { reason: "pending_open_infinite", state: "pending" } })
  })
}

function consentWords(mode: "not_required" | "required"): string {
  return mode === "required" ? "ask first (consent required)" : "collect by default"
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

function ga4PageViewsRow(visit: NonNullable<ProvenColumnInput["visit"]>, expect: TestExpect, at: string): RowCellInput {
  if (!expect.ga4) return { value: null, state: "not_measured", source: "desktop_test", at, reason: "not_connected" }
  const views = visit.result.ga4.events.filter((event) => event.en === "page_view" && expect.ga4!.includes(event.tid) && !event.afterNav)
  const grade = visit.grades.ga4
  // A tool the grader could not grade (held by consent, a bot-flagged window, …) is UNKNOWN, never a
  // problem: what this visit did not see says nothing about the site.
  if (!grade || grade.state === "undetermined") {
    return { value: null, state: "undetermined", source: "desktop_test", at, checkId: "ga4_seen_leaving", reason: reportReason(grade?.reason) }
  }
  const sent = views.some((event) => typeof event.status === "number" && event.status >= 200 && event.status < 300)
  return {
    value: views.length,
    display: `${views.length}${sent ? " · sent (seen leaving)" : ""}`,
    state: views.length === 1 ? "pass" : "problem",
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

function metaPixelRow(visit: NonNullable<ProvenColumnInput["visit"]>, expect: TestExpect, at: string): RowCellInput {
  if (!expect.meta) return { value: null, state: "not_measured", source: "desktop_test", at, reason: "not_connected" }
  const blocked = visit.result.meta.console.includes("traffic_permissions_blocked")
  const tr = visit.result.meta.tr.filter((event) => expect.meta!.includes(event.pixelId))
  const sent = tr.some((event) => typeof event.status === "number" && event.status >= 200 && event.status < 300)
  if (blocked) return { value: "blocked", display: `blocked on ${visit.result.loads[0]?.finalUrl ? new URL(visit.result.loads[0].finalUrl).host : "the site"}`, state: "problem", source: "desktop_test", at, checkId: "meta_seen_leaving" }
  if (sent) return { value: "sending", display: "sending · domain allowed", state: "pass", source: "desktop_test", at, checkId: "meta_seen_leaving" }
  return { value: "not seen", display: "no Meta event seen leaving", state: tr.length > 0 ? "problem" : "undetermined", source: "desktop_test", at, checkId: "meta_seen_leaving" }
}

function posthogRouteRow(lane: LaneReceipt, visit: ProvenColumnInput["visit"], expect: TestExpect, at: string): RowCellInput {
  if (!expect.posthog) return { value: null, state: "not_measured", source: "cloud_receipt", at, reason: "not_connected" }
  if (!visit) return { value: null, state: "pending", source: "cloud_receipt", at, reason: "pending_open_infinite" }
  const viaProxy = posthogViaProxy(visit)
  const found = lane.state === "verified"
  // The visit saw no PostHog event: the route is unknown (never "direct").
  if (viaProxy === null) {
    return { value: null, state: "undetermined", source: "cloud_receipt", at, checkId: "posthog_distinct_id_receipt", reason: reportReason(visit.grades.posthog?.reason) }
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

/** The proof state the winner PATCHes: proven only with receipts for every installed tool and no problem. */
export function proofStateFrom(column: ReportColumnSnapshot): "proven" | "problem" | "undetermined" {
  const proof = column.finishLine.proof_from_real_visit
  const once = column.finishLine.each_tool_once
  if (proof?.state === "problem" || once?.state === "problem") return "problem"
  if (proof?.state === "pass" && once?.state === "pass") return "proven"
  return "undetermined"
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

function productionHostFrom(keys: TagKeys, hosting: TagHosting): string | null {
  return keys.infinite.productionHosts[0] ?? hosting.vercel?.productionDomains[0] ?? null
}

async function runProve(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome> {
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
  const keys = await deps.bridge.keys()
  const expect = testExpectFromKeys(keys)
  const productionHost = productionHostFrom(keys, hosting)

  const deploy = await waitForDeploy(ctx, deps, mergeSha, hosting.vercel?.productionBranch ?? null)
  if (!deploy.deployed) {
    return {
      kind: "parked",
      code: "INF_WIZ_DEPLOY_TIMEOUT",
      reason: `The deploy of ${mergeSha.slice(0, 7)} was not seen in ${Math.round(PROVE_LIMITS.deployWaitMs / 60_000)} minutes.`,
      resumeHint: "Open Infinite: it finishes the proof after the deploy and shows it in Site Settings. Or run npx infinite-tag again later."
    }
  }
  ctx.emit.emit("step.sub", {
    step: "prove",
    text: deploy.how === "merge_deployment" ? `✓ Deployed ${mergeSha.slice(0, 7)}` : `✓ Deployed (a later commit, ${deploy.sha.slice(0, 7)}, includes it)`,
    tone: "ok"
  })

  // The claim: only the winner visits. The cloud's claim is one atomic `pending|pending_desktop → proving`;
  // a run the desktop is proving, or one already proven, answers 409 claimed_by_other with its state.
  let won = false
  let claimNote = ""
  // This process's own earlier claim (a resume after Ctrl+C, a sleep or a crash between the visit and
  // the PATCH): the cloud answers 409 to it like to anyone's, so the saved record tells them apart.
  let ownClaim: ProveVisitRecord | null = null
  let patchProofState = false
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
    claimNote = ownClaim
      ? "this run's own visit, from before the resume"
      : proofState === "proving" || proofState === null
        ? "the Infinite app is already proving this run"
        : `this run's proof is already ${proofState}`
  }

  let visit: ProvenColumnInput["visit"] = null
  let markers: ReceiptMarkers = {}
  let visitError: string | null = null
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
  } else if (won) {
    if (!productionHost) {
      visitError = "no production host is known for this site"
    } else {
      ctx.emit.emit("step.sub", { step: "prove", text: `One real test visit to ${productionHost}…`, tone: "pending" })
      const result = await runRealVisit(ctx, deps, runId, productionHost, keys, expect)
      if ("error" in result) visitError = result.error
      else {
        // §3z.12 §3e.7 (B11): the grader always gets the consent mode, the installed tools and whose Meta pixel it is.
        const census = await deps.checks.census(ctx.root, ctx.appRoot)
        const consentMode = state.plan?.answers.consentMode ?? keys.infinite.consentMode
        const grades = await deps.checks.gradeTestRun(result, expect, "real_visit", gradeContextFrom({ census, consentMode, cmpDetected: result.environment.cmpDetected }))
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
      const census = await deps.checks.census(ctx.root, ctx.appRoot)
      const consentMode = state.plan?.answers.consentMode ?? keys.infinite.consentMode
      const grades = await deps.checks.gradeTestRun(stored, expect, "real_visit", gradeContextFrom({ census, consentMode, cmpDetected: stored.environment.cmpDetected }))
      visit = { result: stored, grades }
      markers = receiptMarkersFrom(stored, expect)
    }
  }

  const receipts = await readReceipts(ctx, deps, runId, markers)
  for (const [lane, receipt] of Object.entries(receipts.lanes) as Array<[ReceiptLane, LaneReceipt]>) {
    ctx.emit.emit("receipt", { lane, state: receipt.state, receiptAt: receipt.receiptAt, runId })
  }
  for (const tool of toolsUnderTest(expect)) {
    const lane = receipts.lanes[TOOL_LANES[tool]]
    const fired = lane.state === "verified" || lane.state === "delivering"
    ctx.emit.emit("step.sub", { step: "prove", text: `${fired ? "✓" : "·"} ${TOOL_LABELS[tool]} · ${RECEIPT_TEXT[lane.state]}`, tone: fired ? "ok" : "warn" })
  }

  // T1 after the deploy (read-only).
  const t1: CheckResult[] = []
  if (productionHost) {
    const url = `https://${productionHost}/`
    t1.push(...(await deps.checks.redirectWalk([url])), ...(await deps.checks.csp(url)))
  }

  // §3z.12 §3e.1 (B15): the passive checks read real events AFTER the deploy (baseline since = deploy time).
  await applyPassiveChecks(ctx, deps, runId, deployedSince(state, deps))

  const at = deps.clock.now().toISOString()
  const column = buildProvenColumn({
    runId,
    mergeSha,
    at,
    keys,
    expect,
    visit,
    receipts,
    t1,
    serverLaneInstalled: keys.serverLane.laneState !== "no_secret",
    conversionsWaiting: state.jobs.filter((item) => item.jobId === "server_conversions" && ["done_in_code", "waiting_real_event"].includes(item.state)).length
  })
  ctx.state.update((draft) => {
    draft.report.proven_live = column
  })
  await ctx.state.save()

  let proofState: "proven" | "problem" | "undetermined" | null = null
  if (patchProofState) {
    proofState = visitError ? "undetermined" : proofStateFrom(column)
    // §3z.8 (A10): the proofState PATCH names its producer, which holds the claim.
    await deps.bridge.patchRun(runId, { proofState }, { producer: "tag" })
  } else if (ownClaim) {
    proofState = visitError ? "undetermined" : proofStateFrom(column)
  }

  const distinctId = visit?.result.markers.posthogDistinctId ?? state.markers.prove.posthogDistinctId ?? null
  if (distinctId) {
    ctx.emit.emit("step.sub", { step: "prove", text: `Filter this visitor out in PostHog: distinct_id = ${distinctId}`, tone: "info" })
  }

  const lanes = toolsUnderTest(expect)
  const passed = lanes.filter((tool) => ["verified", "delivering"].includes(receipts.lanes[TOOL_LANES[tool]].state)).length
  if (visitError) {
    return { kind: "failed", code: "INF_WIZ_PROOF_INCOMPLETE", message: `The real visit could not run: ${visitError}.`, next: "continue" }
  }
  const tail = won || ownClaim ? "" : " (receipts from the Infinite app's visit)"
  return { kind: "ok", status: `${passed} of ${lanes.length} tools passed the live test${tail}${proofState === "problem" ? " · problems found" : ""}` }
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
async function applyPassiveChecks(ctx: WizardContext, deps: WizardDeps, runId: string, since: string | null): Promise<void> {
  const waiting = ctx.state.get().jobs.filter((item) => item.state === "waiting_real_event" && item.checks.some((check) => check.tier === "P"))
  if (waiting.length === 0 || since === null || !deps.bridge.has("tag.baseline.v1")) return
  let baseline: Awaited<ReturnType<WizardDeps["bridge"]["baseline"]>>
  try {
    baseline = await deps.bridge.baseline(runId, { since, signal: ctx.signal })
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
