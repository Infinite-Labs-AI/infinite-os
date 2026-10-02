// Fakes for lane O8's `before` step tests. Every collaborator records its calls into ONE ordered log, so
// the tests can assert the call order. Anything `before` must not touch throws when it is used (the
// report builder, the agent runner, the git host's write methods, the state-changing bridge verbs).
import type { AgentRunner } from "../../../src/wizard/contracts/agents.js"
import type { HostingResponse, KeysResponse, TagBridgeClient, TestRunPollResponse } from "../../../src/wizard/contracts/bridge.js"
import { testRequestModeErrors, type TestResult, type TestRunRequest } from "../../../src/wizard/contracts/test-engine.js"
import type { RunStateAccessor, WizardContext, WizardDeps, WizardEmitter, WizardFs } from "../../../src/wizard/contracts/deps.js"
import type { WizardEventFields, WizardEventType } from "../../../src/wizard/contracts/events.js"
import type { GitHostAdapter, GitOps } from "../../../src/wizard/contracts/git-host.js"
import type { BuildResult, CensusResult, CheckResult, CheckRunner, Installer, JobRegistry, ScanResult } from "../../../src/wizard/contracts/jobs.js"
import type { ReportBuilder } from "../../../src/wizard/contracts/report.js"
import { WIZARD_STATE_SCHEMA, type WizardRunState } from "../../../src/wizard/contracts/state.js"
import type { TestTool } from "../../../src/wizard/contracts/test-engine.js"
import { baselineResponse, census as makeCensus, fixtureDryLive, hostingResponse, keysResponse, RUN_ID } from "./fixtures.js"

export type CallLog = string[]

/** An object whose every unlisted property throws on use ("before must not call X"). */
function strict<T extends object>(name: string, implemented: Partial<T>): T {
  return new Proxy(implemented as T, {
    get(target, property, receiver) {
      if (property === "then" || typeof property === "symbol") return Reflect.get(target, property, receiver)
      if (!(property in target)) {
        return () => {
          throw new Error(`${name}.${String(property)} must not be called by before`)
        }
      }
      return Reflect.get(target, property, receiver)
    }
  })
}

export class FakeBridgeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false
  ) {
    super(`${status} ${code}`)
  }
}

export interface FakeBridgeOptions {
  keys?: KeysResponse | FakeBridgeError
  hosting?: HostingResponse
  /** Polls answered in order; the last repeats. */
  polls?: TestRunPollResponse[]
  baseline?: Record<string, unknown>
}

/** Rejects any production `dry_live` that carries clicks or the fake click id (R2-06): the test fails. */
export function assertNoSendOnProduction(request: Omit<TestRunRequest, "protocolVersion" | "requestId">): void {
  if (request.mode !== "dry_live") return
  if (request.clicks !== undefined || request.fakeClickId !== undefined) {
    throw new Error("before sent clicks or a fake click id to production")
  }
  const errors = testRequestModeErrors({ protocolVersion: 1, requestId: "x", ...request }, (host) => host === request.productionHost || host.endsWith(`.${request.productionHost}`))
  if (errors.length > 0) throw new Error(`invalid dry_live request: ${errors.join("; ")}`)
}

export function fakeBridge(log: CallLog, options: FakeBridgeOptions = {}) {
  const sentTests: Array<Omit<TestRunRequest, "protocolVersion" | "requestId">> = []
  const hostingCalls: Array<readonly string[] | undefined> = []
  let pollIndex = 0
  const polls = options.polls ?? [
    { protocolVersion: 1, requestId: "r", state: "running", progress: [] },
    { protocolVersion: 1, requestId: "r", state: "done", progress: [], result: fixtureDryLive() }
  ]
  const client = strict<TagBridgeClient>("bridge", {
    async hosting(envNames?: readonly string[]) {
      log.push(envNames ? `bridge.hosting(${envNames.join(",")})` : "bridge.hosting")
      hostingCalls.push(envNames)
      const response = options.hosting ?? hostingResponse()
      if (envNames && response.vercel) {
        return { ...response, vercel: { ...response.vercel, envTargets: Object.fromEntries(envNames.map((name) => [name, ["production" as const]])) } }
      }
      return response
    },
    async keys() {
      log.push("bridge.keys")
      if (options.keys instanceof FakeBridgeError) throw options.keys
      return options.keys ?? keysResponse()
    },
    async startTest(body) {
      log.push(`bridge.test.start(${body.mode})`)
      assertNoSendOnProduction(body)
      sentTests.push(body)
      return { protocolVersion: 1, requestId: "r", testRunId: "tr_FAKEdryLive00000000000", state: "queued" }
    },
    async pollTest() {
      log.push("bridge.test.poll")
      const poll = polls[Math.min(pollIndex, polls.length - 1)]!
      pollIndex += 1
      return poll
    },
    async cancelTest(testRunId: string) {
      log.push("bridge.test.cancel")
      return { protocolVersion: 1, requestId: "r", testRunId, state: "cancelled" }
    },
    async baseline(runId: string) {
      log.push(`bridge.baseline(${runId})`)
      return (options.baseline ?? baselineResponse()) as never
    }
  })
  return { client, sentTests, hostingCalls }
}

export interface FakeGitOptions {
  isRepo?: boolean
  dirtyPaths?: string[]
  createBranchError?: Error
}

export function fakeGit(log: CallLog, options: FakeGitOptions = {}) {
  const branches: Array<{ base: string; branch: string }> = []
  const git = strict<GitOps>("git", {
    async isRepo() {
      log.push("git.isRepo")
      return options.isRepo ?? true
    },
    async cleanTree() {
      log.push("git.cleanTree")
      const dirtyPaths = options.dirtyPaths ?? []
      return { clean: dirtyPaths.length === 0, dirtyPaths }
    },
    async createBranch(base: string, branch: string) {
      log.push(`git.createBranch(${base},${branch})`)
      if (options.createBranchError) throw options.createBranchError
      branches.push({ base, branch })
      return { baseSha: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d" }
    }
  })
  return { git, branches }
}

export function fakeHost(log: CallLog, defaultBranch: string | null = "main"): GitHostAdapter {
  return strict<GitHostAdapter>("host", {
    kind: "github",
    async repoFacts() {
      log.push("host.repoFacts")
      return { isPrivate: true, defaultBranch, viewerPermission: "WRITE" }
    }
  })
}

export interface FakeChecksOptions {
  census?: CensusResult
  grades?: Partial<Record<TestTool, CheckResult>>
  setup?: CheckResult[]
  baselineBuild?: BuildResult
}

const AT = "2026-10-02T09:12:00.000Z"

export function passGrades(): Record<TestTool, CheckResult> {
  const grade = (tool: TestTool): CheckResult => ({ checkId: `dry_live_${tool}`, tier: "T1", state: "pass", at: AT, runId: RUN_ID })
  return { infinite: grade("infinite"), ga4: grade("ga4"), posthog: grade("posthog"), meta: grade("meta") }
}

export function fakeChecks(log: CallLog, options: FakeChecksOptions = {}) {
  const graded: Array<{ result: TestResult; expect: unknown; mode: string; ctx: unknown }> = []
  const checks = strict<CheckRunner>("checks", {
    async buildBaseline() {
      log.push("checks.buildBaseline")
      return options.baselineBuild ?? { ok: true, failureSignature: [], durationMs: 1200 }
    },
    async census(root: string, appRoot: string) {
      log.push(`checks.census(${root},${appRoot})`)
      return options.census ?? makeCensus([])
    },
    async setupChecks(appRoot: string) {
      log.push(`checks.setupChecks(${appRoot})`)
      return options.setup ?? [{ checkId: "click_id_capture", tier: "S", state: "pass", at: AT, runId: RUN_ID }]
    },
    async envTargets() {
      log.push("checks.envTargets")
      return [{ checkId: "env_targets", tier: "T1", state: "pass", at: AT, runId: RUN_ID }]
    },
    async gradeTestRun(result, expect, mode, ctx) {
      log.push(`checks.gradeTestRun(${mode})`)
      graded.push({ result, expect, mode, ctx })
      return { ...passGrades(), ...(options.grades ?? {}) } as Record<TestTool, CheckResult>
    },
    async liveBytes() {
      log.push("checks.liveBytes")
      return [{ checkId: "byte_census", tier: "T1", state: "pass", at: AT, runId: RUN_ID }]
    },
    async redirectWalk() {
      log.push("checks.redirectWalk")
      return [{ checkId: "redirect_walk", tier: "T1", state: "pass", at: AT, runId: RUN_ID }]
    },
    async csp() {
      log.push("checks.csp")
      return [{ checkId: "csp_header", tier: "T1", state: "pass", at: AT, runId: RUN_ID }]
    },
    async metaDomains() {
      log.push("checks.metaDomains")
      return [{ checkId: "meta_traffic_permissions", tier: "T1", state: "pass", at: AT, runId: RUN_ID }]
    }
  })
  return { checks, graded }
}

export function fakeInstaller(log: CallLog, scan: Partial<ScanResult> = {}): Installer {
  return strict<Installer>("installer", {
    async scan(opts) {
      log.push(`installer.scan(${opts.appRoot ?? "."})`)
      return { root: opts.root, appRoot: opts.appRoot ?? ".", framework: "next-app-router", packageManager: "pnpm", fileCount: 214, truncated: false, ...scan }
    }
  })
}

/** Wraps a registry so its calls land in the log too. */
export function spyRegistry(log: CallLog, registry: JobRegistry): JobRegistry {
  return strict<JobRegistry>("registry", {
    seedCandidates(scan, facts) {
      log.push("registry.seedCandidates")
      return registry.seedCandidates(scan, facts)
    }
  })
}

export function memoryFs(log: CallLog, files: Record<string, string> = {}) {
  const store = new Map<string, { text: string; mode: number | undefined }>(Object.entries(files).map(([path, text]) => [path, { text, mode: undefined }]))
  const fs: WizardFs = {
    async readText(path) {
      return store.get(path)?.text ?? null
    },
    async writeTextAtomic(path, text, mode) {
      log.push(`fs.write(${path})`)
      store.set(path, { text, mode })
    },
    async exists(path) {
      return store.has(path)
    },
    async mkdirp() {}
  }
  return { fs, store }
}

export function initialState(overrides: Partial<WizardRunState> = {}): WizardRunState {
  return {
    schema: WIZARD_STATE_SCHEMA,
    runId: RUN_ID,
    displayId: "r-7f3c",
    createdAt: "2026-10-02T09:00:00.000Z",
    tagVersion: "0.11.0",
    root: "/repo",
    appRoot: ".",
    link: { linkId: "lk_FAKElink0000000000000000", workspaceName: "Acme", approvedAt: "2026-10-02T09:00:00.000Z", runtimeVariant: "prod" },
    steps: {},
    agent: null,
    git: null,
    pr: null,
    plan: null,
    jobs: [],
    markers: { before: {}, rehearsal: {}, prove: {} },
    report: { live_today: null, in_pr: null, proven_live: null },
    snapshot: null,
    ...overrides
  }
}

export interface Emitted {
  type: WizardEventType
  fields: unknown
}

export function context(state: WizardRunState, log: CallLog, overrides: Partial<WizardContext> = {}): { ctx: WizardContext; events: Emitted[] } {
  const events: Emitted[] = []
  const accessor: RunStateAccessor = {
    get: () => state,
    update: (mutate) => mutate(state),
    save: async () => {
      log.push("state.save")
    }
  }
  const emit: WizardEmitter = {
    emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]) {
      events.push({ type, fields })
    }
  }
  const ctx: WizardContext = {
    runId: state.runId,
    state: accessor,
    emit,
    ask: async () => {
      throw new Error("before must not ask anything (the keys are read silently)")
    },
    signal: new AbortController().signal,
    options: { json: true, yes: false, answersFile: null, resume: false, noAgent: false, worker: null, reviewer: null, consentMode: null, noProve: false, nested: false },
    root: "/repo",
    appRoot: ".",
    now: () => new Date("2026-10-02T09:05:00.000Z"),
    ...overrides
  }
  return { ctx, events }
}

export function deps(parts: Pick<WizardDeps, "bridge" | "git" | "host" | "checks" | "installer" | "registry" | "fs">): WizardDeps {
  return {
    ...parts,
    agents: strict<AgentRunner>("agents", {}),
    report: strict<ReportBuilder>("report", {}),
    clock: { now: () => new Date("2026-10-02T09:05:00.000Z"), sleep: async () => {} },
    env: {},
    platform: "darwin",
    tagVersion: "0.11.0"
  }
}
