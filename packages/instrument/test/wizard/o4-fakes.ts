// Lane O4's test doubles for WizardDeps: a recording fake bridge, scripted agents, a fake check runner /
// registry / installer / report builder, a fake clock, a real-disk WizardFs, and a WizardContext with an
// in-memory run state, an event log and scripted ask answers. No network, no real agent, no real desktop.
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"

import type { AgentRunner, AgentRunResult, ReviewFailure, ReviewResult, RunJobsInput } from "../../src/wizard/contracts/agents.js"
import type { AskAnswer, AskKind, AskPayloads } from "../../src/wizard/contracts/asks.js"
import { FAKE_BRIDGE_TOKEN, TAG_CAPABILITIES, type TagBridgeClient, type TagCapability, type TagHosting, type TagKeys } from "../../src/wizard/contracts/bridge.js"
import type { Clock, WizardContext, WizardDeps, WizardFs, WizardOptions } from "../../src/wizard/contracts/deps.js"
import type { WizardEventFields, WizardEventType } from "../../src/wizard/contracts/events.js"
import type { GitHostAdapter, GitOps } from "../../src/wizard/contracts/git-host.js"
import type { ChecklistItem, CheckRunner, CheckResult, Installer, JobRegistry } from "../../src/wizard/contracts/jobs.js"
import type { ReportBuilder, ReportV2 } from "../../src/wizard/contracts/report.js"
import { WIZARD_STATE_SCHEMA, type WizardRunState } from "../../src/wizard/contracts/state.js"
import type { TestMode, TestResult, TestRunRequest, TestTool } from "../../src/wizard/contracts/test-engine.js"

export const RUN_ID = "7f3c2a91-b0de-4c55-9a11-23456789abcd"
export const PIXEL_ID = "1234567890123456"
export const GA4_ID = "G-ABC123XYZ9"
export const POSTHOG_KEY = "phc_FAKEprojectKeyForTests000000000000"
export const SITE_KEY = "site_fake_acme"

export function fakeKeys(overrides: Partial<TagKeys> = {}): TagKeys {
  return {
    infinite: { status: "ready", siteSourceKey: SITE_KEY, productionHosts: ["acme-store.com"], consentMode: "not_required", consentStorageKey: "infinite_analytics_consent", collectPath: "/infinite/ledger" },
    ga4: { status: "connected", propertyLabel: "Acme", streams: [{ measurementId: GA4_ID, defaultUri: "https://acme-store.com", streamName: "web" }] },
    posthog: { status: "connected", projectKey: POSTHOG_KEY, apiHost: "https://us.i.posthog.com", ingestHost: "https://us.i.posthog.com", uiHost: "https://us.posthog.com", region: "us" },
    meta: { status: "connected", pixels: [{ pixelId: PIXEL_ID, sourceRef: "src_1", adAccountLabel: "Acme ads" }] },
    serverLane: { laneState: "awaiting_first_event", envWriteGranted: true },
    ...overrides
  }
}

export function fakeHosting(overrides: Partial<NonNullable<TagHosting["vercel"]>> = {}): TagHosting {
  return {
    provider: "vercel",
    vercel: {
      projectRef: "prj_fake",
      projectName: "acme-store",
      productionBranch: "main",
      rootDirectory: null,
      framework: "nextjs",
      productionDomains: ["acme-store.com"],
      productionAliases: ["acme-store.vercel.app"],
      envWriteGranted: true,
      previewProtection: "none",
      ...overrides
    }
  }
}

export function testResult(mode: TestMode, overrides: Partial<TestResult> = {}): TestResult {
  return {
    mode,
    runId: RUN_ID,
    startedAt: "2026-10-02T10:00:00.000Z",
    finishedAt: "2026-10-02T10:00:20.000Z",
    environment: { ua: "Electron InfiniteVerifyCheck/1", automationDetected: false, visibilityState: "visible", blockedBySiteBotRules: false, previewProtected: false, consentSeeded: false, cmpDetected: null },
    loads: [{ label: "home", url: "https://acme-store.com/", finalUrl: "https://acme-store.com/", status: 200, rendered: true, managedMarkerSeen: true, redirects: [] }],
    requests: { total: 10, cancelled: 4, otherBeacons: [] },
    ga4: { events: [{ tid: GA4_ID, en: "page_view", dlHost: "acme-store.com", transport: "get", status: "cancelled", loadLabel: "home", afterNav: false }] },
    posthog: { events: [{ projectKey: POSTHOG_KEY, event: "$pageview", distinctId: "d1", host: "acme-store.com", endpointHost: "acme-store.com", sameOrigin: true, libCustomApiHost: true, status: "cancelled", loadLabel: "home", afterNav: false }], bootRequests: [] },
    infinite: { events: [] },
    meta: { configRequests: [PIXEL_ID], tr: [], console: [], fbc: { present: false, value: null, domain: null }, fbp: { present: true } },
    csp: { violations: [] },
    clicks: [{ label: "sign_up", selector: '[data-infinite-conversion="sign_up"]', found: true, events: { ga4: ["sign_up"], posthog: ["sign_up"], meta: [], infinite: [] }, nonGetCancelled: 1, navigatedAfterMs: null, navigationCancelled: false, refused: null }],
    pii: [],
    serverLaneProbe: null,
    markers: { infiniteEventIds: [], posthogDistinctId: "d1", metaEventIds: [] },
    ...overrides
  }
}

export interface BridgeCall {
  verb: string
  body?: unknown
}

export interface FakeBridge extends TagBridgeClient {
  calls: BridgeCall[]
  testRequests: Array<Omit<TestRunRequest, "protocolVersion" | "requestId">>
}

export function fakeBridge(options: { keys?: TagKeys; hosting?: TagHosting; results?: Partial<Record<TestMode, TestResult>>; capabilities?: TagCapability[]; ga4Refused?: string[] } = {}): FakeBridge {
  const calls: BridgeCall[] = []
  const testRequests: FakeBridge["testRequests"] = []
  const capabilities = new Set(options.capabilities ?? TAG_CAPABILITIES)
  const runs = new Map<string, Omit<TestRunRequest, "protocolVersion" | "requestId">>()
  const env = { protocolVersion: 1 as const, requestId: "req" }
  const notUsed = (verb: string) => async (): Promise<never> => {
    throw new Error(`fake bridge: ${verb} is not used by lane O4`)
  }
  const bridge: FakeBridge = {
    calls,
    testRequests,
    descriptor: {
      schemaVersion: 1,
      service: "infinite-desktop-tag",
      protocol: { min: 1, max: 1 },
      capabilities: [...capabilities],
      url: "http://127.0.0.1:4545",
      pid: 4242,
      bootId: "boot",
      desktopVersion: "0.4.1",
      runtime: { variant: "prod", label: "Infinite" },
      token: FAKE_BRIDGE_TOKEN,
      startedAt: "2026-10-02T09:00:00.000Z"
    },
    has: (capability) => capabilities.has(capability),
    setLinkId: () => undefined,
    status: notUsed("status"),
    requestLink: notUsed("requestLink"),
    pollLink: notUsed("pollLink"),
    revokeLink: notUsed("revokeLink"),
    async keys() {
      calls.push({ verb: "keys" })
      return { ...env, ...(options.keys ?? fakeKeys()) }
    },
    async hosting() {
      calls.push({ verb: "hosting" })
      return { ...env, ...(options.hosting ?? fakeHosting()) }
    },
    deployStatus: notUsed("deployStatus"),
    startRun: notUsed("startRun"),
    claimProof: notUsed("claimProof"),
    async patchRun(runId, patch) {
      calls.push({ verb: "runs.patch", body: { runId, patch } })
      return { ...env, run: {} as never }
    },
    getRun: notUsed("getRun"),
    postReceipts: notUsed("postReceipts"),
    postReport: notUsed("postReport"),
    baseline: notUsed("baseline"),
    ensureSiteSource: notUsed("ensureSiteSource"),
    declareConversions: notUsed("declareConversions"),
    async markGa4KeyEvents(body) {
      calls.push({ verb: "ga4-key-events", body })
      const refused = new Set(options.ga4Refused ?? [])
      return {
        ...env,
        created: body.names.filter((name) => !refused.has(name)),
        alreadyExisted: [],
        refused: body.names.filter((name) => refused.has(name)).map((name) => ({ name, reason: "not_click_tested" as const }))
      }
    },
    serverLaneStatus: notUsed("serverLaneStatus"),
    provisionServerLaneEnv: notUsed("provisionServerLaneEnv"),
    metaRelayStatus: notUsed("metaRelayStatus"),
    enableMetaRelay: notUsed("enableMetaRelay"),
    removeServerLaneEnv: notUsed("removeServerLaneEnv"),
    disableSiteSource: notUsed("disableSiteSource"),
    async startTest(request) {
      calls.push({ verb: `test.${request.mode}`, body: request })
      testRequests.push(request)
      const id = `tr_${String(runs.size + 1).padStart(22, "0")}`
      runs.set(id, request)
      return { ...env, testRunId: id, state: "queued" }
    },
    async pollTest(testRunId) {
      const request = runs.get(testRunId)!
      const result = options.results?.[request.mode] ?? testResult(request.mode)
      return { ...env, state: "done", progress: [{ at: "2026-10-02T10:00:01.000Z", text: "Loading…" }], result }
    },
    async cancelTest(testRunId) {
      calls.push({ verb: "test.cancel" })
      return { ...env, testRunId, state: "cancelled" }
    },
    testFacts: notUsed("test.facts")
  }
  return bridge
}

export interface ScriptedAgents extends AgentRunner {
  reviews: Array<ReviewResult | ReviewFailure>
  reviewCalls: Array<{ worktreeDir: string; brief: string; reviewer: string }>
  jobCalls: RunJobsInput[]
}

/** Agents that replay scripted reviews and run a scripted fix function (no prompt is ever spent). */
export function scriptedAgents(options: {
  reviews?: Array<ReviewResult | ReviewFailure>
  fix?: (input: RunJobsInput, round: number) => Promise<Partial<AgentRunResult>> | Partial<AgentRunResult>
}): ScriptedAgents {
  const reviews = [...(options.reviews ?? [])]
  const agents: ScriptedAgents = {
    reviews,
    reviewCalls: [],
    jobCalls: [],
    async detect() {
      return { worker: null, reviewer: null, nested: null }
    },
    async review(input) {
      agents.reviewCalls.push({ worktreeDir: input.worktreeDir, brief: input.brief, reviewer: input.reviewer })
      const next = reviews.shift()
      if (!next) return { error: "unparseable" }
      return next
    },
    async runJobs(input) {
      agents.jobCalls.push(input)
      const partial = options.fix ? await options.fix(input, agents.jobCalls.length) : {}
      return {
        outcome: "completed",
        session: { kind: "claude", sessionId: "s1" },
        claims: [],
        questions: [],
        permissionDenials: 0,
        reverted: [],
        edits: [],
        ...partial
      }
    },
    isAgentAlive: () => false,
    async killAll() {}
  }
  return agents
}

export function fakeChecks(options: { grades?: Partial<Record<TestMode, Partial<Record<TestTool, CheckResult>>>>; build?: boolean } = {}): CheckRunner & { gradeCalls: TestMode[] } {
  const gradeCalls: TestMode[] = []
  // O6's shape: `checkId: test_run:<tool>`, `reason: "<code> — <detail>"` (a pass carries the detail only).
  const pass = (tool: TestTool, mode: TestMode): CheckResult => ({
    checkId: `test_run:${tool}`,
    state: "pass",
    reason: `${tool} fires once with the connected id`,
    tier: mode === "rehearsal" ? "RH" : "T1",
    at: "2026-10-02T10:00:20.000Z",
    runId: RUN_ID
  })
  return {
    gradeCalls,
    async run(checkId) {
      return { checkId, state: "pass", tier: "S", at: "2026-10-02T10:00:20.000Z", runId: RUN_ID }
    },
    async buildBaseline() {
      return { ok: true, failureSignature: [], durationMs: 1 }
    },
    async build() {
      return options.build === false ? { ok: false, failureSignature: ["TS2304 app/layout.tsx"], durationMs: 1 } : { ok: true, failureSignature: [], durationMs: 1 }
    },
    async t0() {
      return []
    },
    async liveBytes() {
      return []
    },
    async redirectWalk() {
      return []
    },
    async csp() {
      return []
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
    async turnGate() {
      return []
    },
    async gradeTestRun(_result, _expect, mode) {
      gradeCalls.push(mode)
      const scripted = options.grades?.[mode] ?? {}
      const out = {} as Record<TestTool, CheckResult>
      for (const tool of ["infinite", "ga4", "posthog", "meta"] as const) out[tool] = scripted[tool] ?? pass(tool, mode)
      return out
    },
    async gradeTestRunChecks() {
      return []
    },
    register() {}
  }
}

/**
 * A registry whose `apply` follows lane O8's state machine (§3e.5): results merge into the item's checks (by id,
 * tier and THIS run); a claimed item reaches done_in_code only when EVERY local check (S, B, T0) passed, and goes
 * back to pending on a local problem; an RH problem sends a done item back too.
 */
export function fakeRegistry(): JobRegistry {
  const LOCAL = new Set(["S", "B", "T0"])
  return {
    seedCandidates: () => [],
    applyApprovals: (candidates) => [...candidates],
    allowedFiles: (item) => item.allow,
    brief: (items) => `Do only these jobs: ${items.map((item) => item.id).join(", ")}`,
    checksFor: () => [],
    apply(items, results, runId) {
      return items.map((item): ChecklistItem => {
        const checks = item.checks.map((check) => {
          const result = results.find((candidate) => candidate.checkId === check.id && candidate.tier === check.tier && candidate.runId === runId)
          return result ? { ...check, state: result.state, runId, at: result.at, ...(result.reason ? { reason: result.reason } : {}) } : check
        })
        const next: ChecklistItem = { ...item, checks }
        const local = checks.filter((check) => LOCAL.has(check.tier))
        if (next.state === "claimed") {
          if (local.some((check) => check.state === "problem")) next.state = "pending"
          else if (local.length > 0 && local.every((check) => check.state === "pass")) next.state = "done_in_code"
        } else if (next.state === "done_in_code" || next.state === "waiting_deploy") {
          if (checks.some((check) => check.tier === "RH" && check.state === "problem")) next.state = "pending"
        }
        return next
      })
    },
    reverifyNotNeeded: () => ({ agrees: true, evidence: [] })
  }
}

export function fakeInstaller(options: { refreshed?: boolean } = {}): Installer & { recorded: unknown[]; refreshCalls: number } {
  const installer = {
    recorded: [] as unknown[],
    refreshCalls: 0,
    scan: async () => {
      throw new Error("not used")
    },
    artifactsFromKeys: () => {
      throw new Error("not used")
    },
    buildPlan: () => {
      throw new Error("not used")
    },
    planAsk: () => {
      throw new Error("not used")
    },
    apply: async () => {
      throw new Error("not used")
    },
    npmInstall: async () => {
      throw new Error("not used")
    },
    async recordEdits(edits: readonly unknown[]) {
      installer.recorded.push(...edits)
    },
    async refreshEditReceiptFromHead() {
      installer.refreshCalls += 1
      return { refreshed: options.refreshed ?? false }
    },
    uninstall: async () => {
      throw new Error("not used")
    }
  }
  return installer as Installer & { recorded: unknown[]; refreshCalls: number }
}

export function fakeReport(markdown = "| Row | Live site today | In this pull request | Proven live |\n|---|---|---|---|\n| Meta pixel | — | pass | — |"): ReportBuilder {
  return {
    build: (input) =>
      ({
        schema: "infinite-tag.report.v2",
        runId: input.runId,
        tagVersion: input.tagVersion,
        generatedAt: "2026-10-02T10:00:00.000Z",
        site: input.site,
        columns: {
          live_today: { measuredAt: null, sha: null },
          in_pr: { measuredAt: null, sha: null },
          proven_live: { measuredAt: null, sha: null, pending: input.provenLivePending }
        },
        rows: [],
        day7: { measuredAt: null, window: null, cell: null },
        finishLine: [],
        notes: input.notes
      }) as ReportV2,
    renderTerminal: () => markdown,
    renderMarkdown: () => markdown,
    payload: (report) => report
  }
}

export function fakeClock(start = Date.parse("2026-10-02T10:00:00.000Z")): Clock & { slept: number[] } {
  let now = start
  const slept: number[] = []
  return {
    slept,
    now: () => new Date(now),
    async sleep(ms) {
      slept.push(ms)
      now += ms
    }
  }
}

export const diskFs: WizardFs = {
  async readText(path) {
    return existsSync(path) ? readFileSync(path, "utf8") : null
  },
  async writeTextAtomic(path, text, mode = 0o600) {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp-${process.pid}`
    writeFileSync(temp, text, { mode })
    renameSync(temp, path)
  },
  async exists(path) {
    return existsSync(path)
  },
  async mkdirp(path, mode = 0o700) {
    mkdirSync(path, { recursive: true, mode })
  }
}

export function initialState(overrides: Partial<WizardRunState> = {}): WizardRunState {
  return {
    schema: WIZARD_STATE_SCHEMA,
    runId: RUN_ID,
    displayId: "r-7f3c",
    createdAt: "2026-10-02T09:00:00.000Z",
    tagVersion: "0.12.0",
    root: "/repo",
    appRoot: "",
    link: { linkId: "lk_0000000000000000000001", workspaceName: "Acme", approvedAt: "2026-10-02T09:00:00.000Z", runtimeVariant: "prod" },
    steps: {},
    agent: { worker: "claude_code", reviewer: "codex", workerSession: null, whoPays: { worker: null, reviewer: null } },
    git: null,
    pr: null,
    plan: { hash: "sha256:plan", answers: { consentMode: "not_required", conversions: ["sign_up"], privacyApproved: null, npmInstall: null, metaGoal: null }, lines: [] },
    jobs: [],
    markers: { before: {}, rehearsal: {}, prove: {} },
    report: { live_today: null, in_pr: null, proven_live: null },
    snapshot: null,
    ...overrides
  }
}

export interface RecordedEvent {
  type: WizardEventType
  fields: unknown
}

export interface TestContext extends WizardContext {
  events: RecordedEvent[]
  asks: Array<{ kind: AskKind; payload: unknown }>
  saves: number
}

/** A WizardContext over an in-memory run state; `answers[kind]` scripts each ask (a function gets the payload). */
export function testContext(options: {
  root: string
  state: WizardRunState
  answers?: Partial<{ [K in AskKind]: AskAnswer<K> | ((payload: AskPayloads[K]) => AskAnswer<K>) }>
  clock?: Clock
  options?: Partial<WizardOptions>
}): TestContext {
  let state = options.state
  const events: RecordedEvent[] = []
  const asks: TestContext["asks"] = []
  const clock = options.clock ?? fakeClock()
  const ctx: TestContext = {
    events,
    asks,
    saves: 0,
    runId: state.runId,
    root: options.root,
    appRoot: "",
    signal: new AbortController().signal,
    now: () => clock.now(),
    options: { json: true, yes: false, answersFile: null, resume: false, noAgent: false, worker: null, reviewer: null, consentMode: null, noProve: false, nested: false, ...options.options },
    state: {
      get: () => state,
      update(mutate) {
        const draft = structuredClone(state)
        mutate(draft)
        state = draft
      },
      async save() {
        ctx.saves += 1
      }
    },
    emit: {
      emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]) {
        events.push({ type, fields })
      }
    },
    ask: (async (kind: AskKind, payload: unknown) => {
      asks.push({ kind, payload })
      const scripted = (options.answers as Record<string, unknown> | undefined)?.[kind]
      if (scripted === undefined) return "__cancelled__"
      return typeof scripted === "function" ? (scripted as (value: unknown) => unknown)(payload) : scripted
    }) as WizardContext["ask"]
  }
  return ctx
}

export function testDeps(input: {
  bridge: TagBridgeClient
  agents: AgentRunner
  git: GitOps
  host: GitHostAdapter
  checks?: CheckRunner
  registry?: JobRegistry
  installer?: Installer
  report?: ReportBuilder
  clock?: Clock
  env?: Record<string, string | undefined>
}): WizardDeps {
  return {
    bridge: input.bridge,
    agents: input.agents,
    git: input.git,
    host: input.host,
    checks: input.checks ?? fakeChecks(),
    registry: input.registry ?? fakeRegistry(),
    installer: input.installer ?? fakeInstaller(),
    report: input.report ?? fakeReport(),
    fs: diskFs,
    clock: input.clock ?? fakeClock(),
    env: input.env ?? {},
    platform: "darwin",
    tagVersion: "0.12.0"
  }
}

/** The text of every event a test context recorded (for "never reached the terminal" assertions). */
export function eventText(ctx: TestContext): string {
  return JSON.stringify(ctx.events)
}

/** A review in the review.schema.json shape. */
export function review(findings: ReviewResult["findings"], verdict: ReviewResult["verdict"] = findings.length > 0 ? "changes_suggested" : "looks_good"): ReviewResult {
  return {
    verdict,
    summary: findings.length > 0 ? "A few things to fix." : "Looks good.",
    checklist: [{ item: "R1", status: "pass", note: "Scope is fine." }],
    findings
  }
}
