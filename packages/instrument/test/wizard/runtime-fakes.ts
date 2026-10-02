// In-process fakes for lane O1's runtime tests: a scriptable `TagBridgeClient`, an agent runner whose
// liveness the test controls, git / host / installer / checks / registry fakes that record every call in
// order, and a manual clock. (Lane O2 builds the loopback HTTP fake bridge the E2E uses; this one never
// opens a socket.) Every recorded call lands in one shared `calls` list so tests can assert order.
import type { AgentRunner } from "../../src/wizard/contracts/agents.js"
import {
  FAKE_BRIDGE_TOKEN,
  TAG_CAPABILITIES,
  type BridgeDescriptor,
  type DeployStatusResponse,
  type KeysResponse,
  type HostingResponse,
  type RunPatch,
  type TagBridgeClient,
  type TagCapability,
  type TestRunPollResponse,
  type WizardRunPublic
} from "../../src/wizard/contracts/bridge.js"
import type { Clock, WizardContext, WizardDeps, WizardFs, WizardOptions } from "../../src/wizard/contracts/deps.js"
import type { GitHostAdapter, GitOps, PrSummary } from "../../src/wizard/contracts/git-host.js"
import type { CheckResult, CheckRunner, Installer, JobRegistry } from "../../src/wizard/contracts/jobs.js"
import type { LaneReceipt, ReceiptLane, ReceiptsRequestFields, ReceiptsResponseFields } from "../../src/wizard/contracts/receipts.js"
import type { TestResult, TestTool } from "../../src/wizard/contracts/test-engine.js"
import { WIZARD_STEP_IDS as WIZARD_STEP_IDS_FOR_FAKES, WIZARD_STEP_META as WIZARD_STEP_META_FOR_FAKES } from "../../src/wizard/contracts/steps.js"
import { createReportBuilder } from "../../src/wizard/report.js"

export const RUN_ID = "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80"
export const MERGE_SHA = "9f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6"
export const SERVING_SHA = "1111111111111111111111111111111111111111"
export const HOST = "www.acme-store.com"
export const PIXEL_ID = "1234567890123456"
export const GA4_ID = "G-ACME000001"
export const POSTHOG_KEY = "phc_FAKEprojectkeynotreal0000000000000000"
export const SITE_SOURCE_KEY = "site_FAKEnotreal0001"

export interface Call {
  who: string
  what: string
  args: unknown[]
}

export class CallLog {
  readonly calls: Call[] = []
  push(who: string, what: string, ...args: unknown[]): void {
    this.calls.push({ who, what, args })
  }
  names(who?: string): string[] {
    return this.calls.filter((call) => !who || call.who === who).map((call) => `${call.who}.${call.what}`)
  }
}

/** A §3a-shaped error the real client throws (code + optional state). */
export class FakeBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly state?: string
  ) {
    super(`bridge ${status} ${code}`)
  }
}

export function keysFixture(overrides: Partial<KeysResponse> = {}): KeysResponse {
  return {
    protocolVersion: 1,
    requestId: "req-keys",
    infinite: {
      status: "ready",
      siteSourceKey: SITE_SOURCE_KEY,
      productionHosts: [HOST],
      consentMode: "not_required",
      consentStorageKey: "infinite_analytics_consent",
      collectPath: "/infinite/ledger"
    },
    ga4: { status: "connected", propertyLabel: "Acme", streams: [{ measurementId: GA4_ID, defaultUri: `https://${HOST}`, streamName: "web" }] },
    posthog: {
      status: "connected",
      projectKey: POSTHOG_KEY,
      apiHost: "https://us.i.posthog.com",
      ingestHost: "https://us.i.posthog.com",
      uiHost: "https://us.posthog.com",
      region: "us"
    },
    meta: { status: "connected", pixels: [{ pixelId: PIXEL_ID, sourceRef: "src_meta_1", adAccountLabel: "Acme ads" }] },
    serverLane: { laneState: "awaiting_first_event", envWriteGranted: true },
    ...overrides
  }
}

export function realVisitResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    mode: "real_visit",
    runId: RUN_ID,
    startedAt: "2026-10-02T09:40:00.000Z",
    finishedAt: "2026-10-02T09:41:00.000Z",
    environment: {
      ua: "Electron InfiniteVerifyCheck/1",
      automationDetected: false,
      visibilityState: "visible",
      blockedBySiteBotRules: false,
      previewProtected: false,
      consentSeeded: false,
      cmpDetected: null
    },
    loads: [{ label: "home", url: `https://${HOST}/`, finalUrl: `https://${HOST}/`, status: 200, rendered: true, managedMarkerSeen: true, redirects: [] }],
    requests: { total: 40, cancelled: 0, otherBeacons: [] },
    ga4: { events: [{ tid: GA4_ID, en: "page_view", dlHost: HOST, transport: "beacon", status: 204, loadLabel: "home", afterNav: false }] },
    posthog: {
      events: [
        {
          projectKey: POSTHOG_KEY,
          event: "$pageview",
          distinctId: "0192-fake-distinct-4c03",
          host: HOST,
          endpointHost: HOST,
          sameOrigin: true,
          libCustomApiHost: true,
          status: 200
        }
      ],
      bootRequests: [{ path: "/flags", status: 200 }]
    },
    infinite: { events: [{ siteSourceKey: SITE_SOURCE_KEY, eventName: "page_view", eventId: "evt_FAKE0301", nav: false, status: 202 }] },
    meta: {
      configRequests: [PIXEL_ID],
      tr: [{ pixelId: PIXEL_ID, ev: "PageView", eid: null, method: "GET", status: 200 }],
      console: [],
      fbc: { present: false, value: null, domain: null },
      fbp: { present: true }
    },
    csp: { violations: [] },
    clicks: [],
    pii: [],
    serverLaneProbe: { path: "/__infinite_probe/7f3c2a91b0de", status: 404, sentAt: "2026-10-02T09:40:30.000Z" },
    markers: { infiniteEventIds: ["evt_FAKE0301"], posthogDistinctId: "0192-fake-distinct-4c03", metaEventIds: [] },
    ...overrides
  } as TestResult
}

export function lane(state: LaneReceipt["state"], receiptAt: string | null = null, provenance: LaneReceipt["provenance"] = "cloud_ledger"): LaneReceipt {
  return { state, receiptAt, reason: null, provenance }
}

export function receiptsAll(overrides: Partial<Record<ReceiptLane, LaneReceipt>> = {}): ReceiptsResponseFields {
  return {
    runId: RUN_ID,
    phase: "proven_live",
    checkedAt: "2026-10-02T09:42:00.000Z",
    lanes: {
      infinite: lane("verified", "2026-10-02T09:40:05.000Z"),
      posthog: lane("verified", "2026-10-02T09:40:06.000Z", "posthog_query"),
      ga4: lane("delivering", null, "desktop_test"),
      meta_pixel: lane("delivering", null, "desktop_test"),
      server_lane: lane("verified", "2026-10-02T09:40:31.000Z"),
      meta_capi: lane("not_verifiable", null, "relay_ledger"),
      ...overrides
    }
  }
}

function envelope<T extends object>(fields: T): T & { protocolVersion: 1; requestId: string } {
  return { protocolVersion: 1, requestId: "req-fake", ...fields }
}

export function runPublic(overrides: Partial<WizardRunPublic> = {}): WizardRunPublic {
  return {
    runId: RUN_ID,
    tagVersion: "0.12.0",
    repoFingerprint: `sha256:${"a".repeat(64)}`,
    worker: "claude_code",
    reviewer: "codex",
    startedAt: "2026-10-02T09:00:00.000Z",
    phase: "merged",
    prUrl: "https://github.com/acme/acme-store/pull/42",
    prNumber: 42,
    prHeadSha: "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d",
    mergeSha: MERGE_SHA,
    mergedAt: "2026-10-02T09:35:00.000Z",
    deployedSha: null,
    deployedAt: null,
    proofState: "pending",
    proofClaimedBy: null,
    approvedConversions: [],
    clickTestedConversions: [],
    checkinOptIn: false,
    checkinDueAt: null,
    checkinDoneAt: null,
    ...overrides
  }
}

export interface FakeBridgeScript {
  capabilities?: readonly TagCapability[]
  keys?: KeysResponse
  hosting?: HostingResponse
  /** Answered in order; the last one repeats. */
  deploy?: Array<Omit<DeployStatusResponse, "protocolVersion" | "requestId">>
  claim?: "granted" | { code: string; state?: string }
  /** The real-visit poll answers (the last one repeats). */
  testPolls?: Array<Omit<TestRunPollResponse, "protocolVersion" | "requestId">>
  receipts?: ReceiptsResponseFields[]
  patchRun?: (patch: RunPatch) => WizardRunPublic
  reportEcho?: (phase: string, runId: string) => { schema: string; runId: string }
}

export function createFakeBridge(log: CallLog, script: FakeBridgeScript = {}): TagBridgeClient & { linkId: string | null } {
  const caps = new Set<string>(script.capabilities ?? TAG_CAPABILITIES)
  let deployIndex = 0
  let pollIndex = 0
  let receiptsIndex = 0
  const descriptor: BridgeDescriptor = {
    schemaVersion: 1,
    service: "infinite-desktop-tag",
    protocol: { min: 1, max: 1 },
    capabilities: [...caps],
    url: "http://127.0.0.1:4242",
    pid: 4242,
    bootId: "boot-fake",
    desktopVersion: "0.4.1",
    runtime: { variant: "prod", label: "Infinite" },
    token: FAKE_BRIDGE_TOKEN,
    startedAt: "2026-10-02T09:00:00.000Z"
  }
  const record = (what: string, ...args: unknown[]) => log.push("bridge", what, ...args)
  const bridge = {
    descriptor,
    linkId: null as string | null,
    has: (capability: TagCapability) => caps.has(capability),
    setLinkId(linkId: string | null) {
      bridge.linkId = linkId
    },
    async status() {
      record("status")
      return envelope({ service: "infinite-desktop-tag" as const, bootId: "boot-fake", desktopVersion: "0.4.1", runtime: descriptor.runtime, signedIn: true as const, capabilities: [...caps], protocol: { min: 1, max: 1 } })
    },
    async requestLink(body: unknown) {
      record("requestLink", body)
      return envelope({ linkRequestId: "lr_FAKEFAKEFAKEFAKEFAKE00", state: "approved" as const, expiresAt: "2026-10-02T09:05:00.000Z" })
    },
    async pollLink(id: string) {
      record("pollLink", id)
      return envelope({ state: "approved" as const })
    },
    async revokeLink(linkId: string) {
      record("revokeLink", linkId)
      return envelope({ revoked: true as const })
    },
    async keys() {
      record("keys")
      return script.keys ?? keysFixture()
    },
    async hosting(envNames?: readonly string[]) {
      record("hosting", envNames)
      return (
        script.hosting ??
        envelope({
          provider: "vercel" as const,
          vercel: {
            projectRef: "prj_fake",
            projectName: "acme-store",
            productionBranch: "main",
            rootDirectory: null,
            framework: "nextjs",
            productionDomains: [HOST],
            productionAliases: ["acme-store.vercel.app"],
            envWriteGranted: true,
            previewProtection: "none" as const
          }
        })
      )
    },
    async deployStatus(sha: string) {
      record("deployStatus", sha)
      const answers = script.deploy ?? [{ mergeDeployment: { state: "ready" as const, readyAt: "2026-10-02T09:38:00.000Z" }, serving: { sha, readyAt: "2026-10-02T09:38:00.000Z", createdAt: "2026-10-02T09:36:00.000Z", ref: "main" }, target: "production" as const }]
      const answer = answers[Math.min(deployIndex, answers.length - 1)]!
      deployIndex += 1
      return envelope(answer)
    },
    async startRun(body: unknown) {
      record("startRun", body)
      return envelope({ runId: RUN_ID, startedAt: "2026-10-02T09:00:00.000Z" })
    },
    async claimProof(runId: string, producer: string) {
      record("claimProof", runId, producer)
      const claim = script.claim ?? "granted"
      if (claim !== "granted") throw new FakeBridgeError(409, claim.code, claim.state)
      return envelope({ granted: true as const, proofState: "proving" as const })
    },
    async patchRun(runId: string, patch: RunPatch) {
      record("patchRun", runId, patch)
      return envelope({ run: script.patchRun ? script.patchRun(patch) : runPublic({ ...(patch.checkinOptIn ? { checkinOptIn: true, checkinDueAt: "2026-10-09T09:45:00.000Z" } : {}) }) })
    },
    async getRun(runId: string) {
      record("getRun", runId)
      return envelope({ run: runPublic() })
    },
    async postReceipts(runId: string, body: ReceiptsRequestFields) {
      record("postReceipts", runId, body)
      const answers = script.receipts ?? [receiptsAll()]
      const answer = answers[Math.min(receiptsIndex, answers.length - 1)]!
      receiptsIndex += 1
      return envelope(answer)
    },
    async postReport(runId: string, phase: string, report: unknown) {
      record("postReport", runId, phase, report)
      const echo = script.reportEcho ? script.reportEcho(phase, runId) : { schema: "infinite-tag.report.v2", runId }
      return envelope({ id: `rep_${phase}`, phase, storedAt: "2026-10-02T09:45:00.000Z", echo })
    },
    async baseline(runId: string) {
      record("baseline", runId)
      throw new Error("baseline not scripted")
    },
    async ensureSiteSource(body: unknown) {
      record("ensureSiteSource", body)
      return envelope({ siteSourceKey: SITE_SOURCE_KEY, productionHosts: [HOST], consentMode: "not_required" as const, created: true })
    },
    async declareConversions(body: unknown) {
      record("declareConversions", body)
      return envelope({ declared: [], refused: [] })
    },
    async markGa4KeyEvents(body: unknown) {
      record("markGa4KeyEvents", body)
      return envelope({ created: [], alreadyExisted: [], refused: [] })
    },
    async serverLaneStatus() {
      record("serverLaneStatus")
      return envelope({ laneState: "awaiting_first_event" as const, secretSetAt: null, lastReceivedAt: null, envWriteGranted: true })
    },
    async provisionServerLaneEnv(body: unknown) {
      record("provisionServerLaneEnv", body)
      return envelope({ written: ["INFINITE_SITE_SOURCE_KEY"], mintedNewSecret: false, redeploy: { skipped: true as const, reason: "not_requested" }, status: { laneState: "awaiting_first_event" as const, secretSetAt: null, lastReceivedAt: null, envWriteGranted: true } })
    },
    async metaRelayStatus() {
      record("metaRelayStatus")
      return envelope({ available: false, reason: "not_rolled_out" as const, bound: null, enabled: false })
    },
    async enableMetaRelay(body: unknown) {
      record("enableMetaRelay", body)
      return envelope({ available: true, reason: null, bound: null, enabled: true })
    },
    async removeServerLaneEnv() {
      record("removeServerLaneEnv")
      return envelope({ removed: ["INFINITE_SITE_SOURCE_KEY", "INFINITE_SERVER_EVENT_SECRET"] })
    },
    async disableSiteSource() {
      record("disableSiteSource")
      return envelope({ disabled: true as const })
    },
    async startTest(body: unknown) {
      record("startTest", body)
      return envelope({ testRunId: "tr_FAKEFAKEFAKEFAKEFAKE00", state: "queued" as const })
    },
    async pollTest(id: string) {
      record("pollTest", id)
      const answers = script.testPolls ?? [{ state: "done" as const, progress: [], result: realVisitResult() }]
      const answer = answers[Math.min(pollIndex, answers.length - 1)]!
      pollIndex += 1
      return envelope(answer)
    },
    async cancelTest(id: string) {
      record("cancelTest", id)
      return envelope({ testRunId: id, state: "cancelled" as const })
    }
  }
  return bridge as unknown as TagBridgeClient & { linkId: string | null }
}

export function createFakeAgents(log: CallLog): AgentRunner & { alive: boolean } {
  const agents = {
    alive: false,
    async detect() {
      log.push("agents", "detect")
      return { worker: null, reviewer: null, nested: null }
    },
    async runJobs() {
      log.push("agents", "runJobs")
      throw new Error("runJobs not scripted")
    },
    async review() {
      log.push("agents", "review")
      return { error: "unparseable" as const }
    },
    isAgentAlive() {
      return agents.alive
    },
    async killAll() {
      log.push("agents", "killAll")
      agents.alive = false
    }
  }
  return agents
}

export interface FakeGitScript {
  ancestors?: Array<[string, string]>
  /** Commits this clone has not fetched yet: `isAncestor` on one throws (git exits 128) until `remoteBranchSha` fetches. */
  unfetched?: string[]
  clean?: boolean
  dirtyPaths?: string[]
  createBranchFails?: boolean
  remote?: string | null
}

export function createFakeGit(log: CallLog, script: FakeGitScript = {}): GitOps {
  const ancestors = new Set((script.ancestors ?? []).map(([a, b]) => `${a}..${b}`))
  const unfetched = new Set(script.unfetched ?? [])
  return {
    async isRepo() {
      log.push("git", "isRepo")
      return true
    },
    async cleanTree() {
      log.push("git", "cleanTree")
      return { clean: script.clean ?? true, dirtyPaths: script.dirtyPaths ?? [] }
    },
    async remoteUrl() {
      return script.remote === undefined ? "https://user:ghp_FAKE@github.com/Acme/acme-store.git" : script.remote
    },
    async createBranch(base: string, branch: string) {
      log.push("git", "createBranch", base, branch)
      if (script.createBranchFails) throw new Error("fetch refused")
      return { baseSha: "b".repeat(40) }
    },
    async head() {
      return "c".repeat(40)
    },
    async stage(paths: readonly string[]) {
      log.push("git", "stage", [...paths])
    },
    async commit(input: { message: string; trailers: Record<string, string> }) {
      log.push("git", "commit", input)
      return { sha: "d".repeat(40), hookRewrote: [] }
    },
    async push(branch: string) {
      log.push("git", "push", branch)
    },
    async pullFfOnly() {
      return { headSha: "c".repeat(40) }
    },
    async worktreeAddDetached() {
      return { dir: "/nowhere" }
    },
    async worktreeRemove() {},
    async diff() {
      return ""
    },
    async isAncestor(a: string, b: string) {
      log.push("git", "isAncestor", a, b)
      if (unfetched.has(a) || unfetched.has(b)) throw new Error(`git merge-base exited 128: Not a valid commit name ${unfetched.has(a) ? a : b}`)
      return ancestors.has(`${a}..${b}`)
    },
    async remoteBranchSha(branch: string) {
      log.push("git", "remoteBranchSha", branch)
      unfetched.clear()
      return "f".repeat(40)
    }
  }
}

export function prSummary(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 43,
    url: "https://github.com/acme/acme-store/pull/43",
    nodeId: "PR_fake",
    isDraft: true,
    state: "OPEN",
    headRefOid: "e".repeat(40),
    mergeCommitOid: null,
    mergedAt: null,
    mergeStateStatus: "CLEAN",
    reviewDecision: "",
    ...overrides
  }
}

export function createFakeHost(log: CallLog, script: { pr?: PrSummary; readPr?: PrSummary } = {}): GitHostAdapter {
  const unsupported = { unsupported: true as const }
  return {
    kind: "github",
    async auth() {
      return { ok: true, login: "acme-dev" }
    },
    async repoFacts() {
      return { isPrivate: true, defaultBranch: "main", viewerPermission: "ADMIN" }
    },
    async findPr() {
      return null
    },
    async createDraftPr(input) {
      log.push("host", "createDraftPr", input)
      return script.pr ?? prSummary()
    },
    async readPr(number) {
      log.push("host", "readPr", number)
      return script.readPr ?? prSummary({ number })
    },
    async readThreads() {
      return []
    },
    async postReview() {
      return unsupported
    },
    async reply() {},
    async resolve() {},
    async markReady() {},
    async checks() {
      return []
    },
    async comment(number, body) {
      log.push("host", "comment", number, body)
    },
    async updateBranch() {},
    async previewUrl() {
      return null
    },
    async rules() {
      return { requiresReview: false, mergeQueue: false }
    }
  }
}

function result(checkId: string, state: CheckResult["state"], tier: CheckResult["tier"] = "T1"): CheckResult {
  return { checkId, state, tier, at: "2026-10-02T09:43:00.000Z", runId: RUN_ID }
}

export function createFakeChecks(log: CallLog, grades?: Partial<Record<TestTool, CheckResult>>): CheckRunner {
  const pass = (tool: TestTool): CheckResult => ({ ...result(`real_visit_${tool}`, "pass", "PV") })
  return {
    async run(checkId, input) {
      log.push("checks", "run", checkId, input)
      return result(checkId, "pass", "S")
    },
    async buildBaseline() {
      return { ok: true, failureSignature: [], durationMs: 1 }
    },
    async build() {
      log.push("checks", "build")
      return { ok: true, failureSignature: [], durationMs: 1 }
    },
    async t0() {
      log.push("checks", "t0")
      return []
    },
    async liveBytes() {
      return []
    },
    async redirectWalk(urls) {
      log.push("checks", "redirectWalk", urls)
      return [result("redirect_walk", "pass")]
    },
    async csp(url) {
      log.push("checks", "csp", url)
      return [result("csp_header", "pass")]
    },
    async metaDomains() {
      return []
    },
    async census() {
      return { entries: [], envSourcedIds: [], identify: { identifyCalls: [], resetCalls: [] } }
    },
    async setupChecks() {
      return []
    },
    async envTargets() {
      return []
    },
    async turnGate(diff) {
      log.push("checks", "turnGate", diff)
      return []
    },
    async gradeTestRun(testResult, expect, mode) {
      log.push("checks", "gradeTestRun", mode)
      return { infinite: pass("infinite"), ga4: pass("ga4"), posthog: pass("posthog"), meta: pass("meta"), ...grades }
    },
    register() {}
  }
}

export function createFakeRegistry(log: CallLog): JobRegistry {
  return {
    seedCandidates: () => [],
    applyApprovals: (candidates) => [...candidates],
    allowedFiles: (item) => item.allow,
    brief: (items) => {
      log.push("registry", "brief", items.map((item) => item.id))
      return `Do these jobs: ${items.map((item) => item.id).join(", ")}`
    },
    checksFor: (item, tier) => (tier === "S" ? [{ tier, checkId: `${item.jobId}_static` }] : []),
    apply: (items, results) => {
      log.push("registry", "apply", items.map((item) => item.id), results.length)
      return items.map((item) => ({ ...item, state: "done_in_code" as const }))
    },
    reverifyNotNeeded: () => ({ agrees: true, evidence: [] })
  }
}

export function createFakeInstaller(log: CallLog, reversed: string[] = ["app/layout.tsx"]): Installer {
  const unused = () => {
    throw new Error("not scripted")
  }
  return {
    scan: unused,
    artifactsFromKeys: unused,
    buildPlan: unused,
    planAsk: unused,
    apply: unused,
    npmInstall: unused,
    recordEdits: async () => {},
    refreshEditReceiptFromHead: async () => ({ refreshed: false }),
    async uninstall(opts) {
      log.push("installer", "uninstall", opts)
      return { reversed, leftAsIs: [] }
    }
  }
}

/** A clock the test moves: `sleep` advances time at once (and honours abort). */
export function manualClock(start = "2026-10-02T09:36:00.000Z"): Clock & { advance(ms: number): void } {
  let now = Date.parse(start)
  return {
    now: () => new Date(now),
    advance(ms: number) {
      now += ms
    },
    async sleep(ms, signal) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" })
      now += ms
    }
  }
}

export const memoryFs = (): WizardFs & { files: Map<string, string> } => {
  const files = new Map<string, string>()
  return {
    files,
    async readText(path) {
      return files.get(path) ?? null
    },
    async writeTextAtomic(path, text) {
      files.set(path, text)
    },
    async exists(path) {
      return files.has(path)
    },
    async mkdirp() {}
  }
}

export function defaultOptions(overrides: Partial<WizardOptions> = {}): WizardOptions {
  return {
    json: true,
    yes: false,
    answersFile: null,
    resume: false,
    noAgent: false,
    worker: null,
    reviewer: null,
    consentMode: null,
    noProve: false,
    nested: false,
    ...overrides
  }
}

export interface FakeDepsBundle {
  log: CallLog
  deps: WizardDeps
  bridge: ReturnType<typeof createFakeBridge>
  agents: ReturnType<typeof createFakeAgents>
  clock: ReturnType<typeof manualClock>
}

export function fakeDeps(script: { bridge?: FakeBridgeScript; git?: FakeGitScript; grades?: Partial<Record<TestTool, CheckResult>>; host?: Parameters<typeof createFakeHost>[1]; reversed?: string[] } = {}): FakeDepsBundle {
  const log = new CallLog()
  const bridge = createFakeBridge(log, script.bridge)
  const agents = createFakeAgents(log)
  const clock = manualClock()
  const deps: WizardDeps = {
    bridge,
    agents,
    git: createFakeGit(log, script.git),
    host: createFakeHost(log, script.host),
    checks: createFakeChecks(log, script.grades),
    registry: createFakeRegistry(log),
    installer: createFakeInstaller(log, script.reversed),
    report: createReportBuilder(() => clock.now()),
    fs: memoryFs(),
    clock,
    env: { HOME: "/nonexistent-home" },
    platform: "darwin",
    tagVersion: "0.12.0"
  }
  return { log, deps, bridge, agents, clock }
}

/** A minimal context over an in-memory state (no store, events recorded in `events`). */
export function fakeContext(
  state: import("../../src/wizard/contracts/state.js").WizardRunState,
  options: Partial<WizardOptions> = {},
  clock: Clock = manualClock()
): WizardContext & { events: Array<{ type: string; fields: unknown }>; current: () => import("../../src/wizard/contracts/state.js").WizardRunState } {
  let current = structuredClone(state)
  const events: Array<{ type: string; fields: unknown }> = []
  const controller = new AbortController()
  return {
    get runId() {
      return current.runId
    },
    events,
    current: () => current,
    state: {
      get: () => current,
      update(mutate) {
        const draft = structuredClone(current)
        mutate(draft)
        current = draft
      },
      async save() {}
    },
    emit: {
      emit(type, fields) {
        events.push({ type, fields })
      }
    },
    ask: (async () => "__timeout__") as WizardContext["ask"],
    signal: controller.signal,
    options: defaultOptions(options),
    root: "/repo",
    appRoot: ".",
    now: () => clock.now()
  }
}

export type StepBehaviour = (ctx: WizardContext, deps: WizardDeps) => Promise<import("../../src/wizard/contracts/deps.js").StepOutcome>

/** A step Record of fakes: each step records its run and returns ok unless a behaviour says otherwise. */
export function fakeStepRecord(
  behaviours: Partial<Record<import("../../src/wizard/contracts/steps.js").WizardStepId, StepBehaviour>>,
  ran: string[] = [],
  hashes: Partial<Record<import("../../src/wizard/contracts/steps.js").WizardStepId, string>> = {}
): import("../../src/wizard/contracts/deps.js").WizardStepRecord {
  const meta = WIZARD_STEP_META_FOR_FAKES
  const entries = WIZARD_STEP_IDS_FOR_FAKES.map((id) => [
    id,
    {
      id,
      title: meta[id].title,
      who: [...meta[id].who],
      learn: meta[id].learn,
      requiredCapabilities: [...meta[id].requiredCapabilities],
      inputHash: () => hashes[id] ?? "h",
      run: async (ctx: WizardContext, deps: WizardDeps) => {
        ran.push(id)
        const behaviour = behaviours[id]
        return behaviour ? behaviour(ctx, deps) : { kind: "ok" as const, status: `${id} ok` }
      }
    }
  ])
  return Object.fromEntries(entries) as unknown as import("../../src/wizard/contracts/deps.js").WizardStepRecord
}
