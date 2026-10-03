// Test helper (never published): an in-memory WizardContext and WizardDeps built from fakes, so a step runs
// against fakes only (never a sibling lane's code). Every collaborator records what it was asked.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname } from "node:path"

import type { AgentRunner } from "../../src/wizard/contracts/agents.js"
import type { AskKind } from "../../src/wizard/contracts/asks.js"
import { FAKE_BRIDGE_TOKEN, TAG_CAPABILITIES, type TagBridgeClient, type TagCapability, type TagKeys } from "../../src/wizard/contracts/bridge.js"
import type { WizardContext, WizardDeps, WizardOptions } from "../../src/wizard/contracts/deps.js"
import type { WizardEventType } from "../../src/wizard/contracts/events.js"
import type { BuildResult, CheckResult, ChecklistItem, CheckRunner, Installer, JobRegistry, T0Scenario, WizardEditRecord } from "../../src/wizard/contracts/jobs.js"
import { WIZARD_STATE_SCHEMA, type WizardRunState } from "../../src/wizard/contracts/state.js"

export const STEP_RUN_ID = "7f3c2a10-0000-4000-8000-0000000000bb"

export function baseState(over: Partial<WizardRunState> = {}): WizardRunState {
  return {
    schema: WIZARD_STATE_SCHEMA,
    runId: null,
    displayId: "r-7f3c",
    createdAt: "2026-10-02T09:00:00.000Z",
    tagVersion: "0.0.0-test",
    root: "/repo",
    appRoot: ".",
    link: { linkId: "lk_0000000000000000000000", workspaceName: "Acme", approvedAt: "2026-10-02T09:00:00.000Z", runtimeVariant: "prod" },
    steps: {},
    agent: null,
    git: null,
    pr: null,
    plan: null,
    jobs: [],
    markers: { before: {}, rehearsal: {}, prove: {} },
    report: { live_today: null, in_pr: null, proven_live: null },
    snapshot: null,
    ...over
  }
}

export const DEFAULT_OPTIONS: WizardOptions = {
  json: false,
  yes: false,
  answersFile: null,
  resume: false,
  noAgent: false,
  worker: null,
  reviewer: null,
  consentMode: null,
  noProve: false,
  nested: false
}

export interface Recorded {
  events: Array<{ type: WizardEventType; fields: Record<string, unknown> }>
  asks: Array<{ kind: AskKind; payload: unknown }>
  saves: number
}

export function makeCtx(input: { root: string; state: WizardRunState; options?: Partial<WizardOptions>; answer?: (kind: AskKind, payload: unknown) => unknown }) {
  const recorded: Recorded = { events: [], asks: [], saves: 0 }
  let state = input.state
  const ctx: WizardContext = {
    runId: state.runId,
    state: {
      get: () => state,
      update: (mutate) => {
        const next = structuredClone(state)
        mutate(next)
        state = next
      },
      save: async () => {
        recorded.saves += 1
      }
    },
    emit: {
      emit: (type, fields) => {
        recorded.events.push({ type, fields: fields as Record<string, unknown> })
      }
    },
    ask: (async (kind: AskKind, payload: unknown) => {
      recorded.asks.push({ kind, payload })
      return input.answer ? input.answer(kind, payload) : "__cancelled__"
    }) as WizardContext["ask"],
    signal: new AbortController().signal,
    options: { ...DEFAULT_OPTIONS, ...input.options },
    root: input.root,
    appRoot: ".",
    now: () => new Date("2026-10-02T10:00:00.000Z")
  }
  return { ctx, recorded, state: () => state }
}

export const FIXTURE_KEYS: TagKeys = {
  infinite: { status: "ready", siteSourceKey: "ss_fixture", productionHosts: ["acme-store.com"], consentMode: null, consentStorageKey: null, collectPath: "/_i/c" },
  ga4: { status: "connected", propertyLabel: "Acme", streams: [{ measurementId: "G-FIXTURE01", defaultUri: "https://acme-store.com", streamName: "web" }] },
  posthog: { status: "not_connected", projectKey: null, apiHost: null, ingestHost: null, uiHost: null, region: null },
  meta: { status: "not_connected", pixels: [] },
  serverLane: { laneState: "no_secret", envWriteGranted: true }
}

export interface BridgeCalls {
  startRun: unknown[]
  patchRun: Array<{ runId: string; patch: unknown; agentAlive: boolean }>
  keys: number
}

export function fakeBridge(options: { missing?: TagCapability[]; startRunError?: unknown; agents?: () => AgentRunner | null } = {}) {
  const calls: BridgeCalls = { startRun: [], patchRun: [], keys: 0 }
  const capabilities = TAG_CAPABILITIES.filter((capability) => !(options.missing ?? []).includes(capability))
  const unexpected = async () => {
    throw new Error("unexpected bridge call in this test")
  }
  const bridge = {
    descriptor: {
      schemaVersion: 1,
      service: "infinite-desktop-tag",
      protocol: { min: 1, max: 1 },
      capabilities,
      url: "http://127.0.0.1:1",
      pid: 1,
      bootId: "00000000-0000-4000-8000-000000000000",
      desktopVersion: "0.4.1",
      runtime: { variant: "prod", label: "Infinite" },
      token: FAKE_BRIDGE_TOKEN,
      startedAt: "2026-10-02T09:00:00.000Z"
    },
    has: (capability: TagCapability) => capabilities.includes(capability),
    setLinkId: () => undefined,
    startRun: async (body: unknown) => {
      calls.startRun.push(body)
      if (options.startRunError) throw options.startRunError
      return { protocolVersion: 1, requestId: "r", runId: STEP_RUN_ID, startedAt: "2026-10-02T10:00:00.000Z" }
    },
    patchRun: async (runId: string, patch: unknown) => {
      calls.patchRun.push({ runId, patch, agentAlive: options.agents?.()?.isAgentAlive() ?? false })
      return { protocolVersion: 1, requestId: "r", run: {} }
    },
    keys: async () => {
      calls.keys += 1
      return { protocolVersion: 1, requestId: "r", ...FIXTURE_KEYS }
    }
  }
  const full = new Proxy(bridge as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : unexpected) })
  return { bridge: full as unknown as TagBridgeClient, calls }
}

export interface CheckCalls {
  run: Array<{ checkId: string; input: unknown }>
  build: number
  buildBaseline: number
  t0: T0Scenario[][]
  turnGate: number
}

/** Check results are scripted per checkId; anything unscripted passes. */
export function fakeChecks(script: { results?: Record<string, Array<CheckResult["state"]>>; build?: BuildResult[]; baseline?: BuildResult; gate?: CheckRunner["turnGate"] } = {}) {
  const calls: CheckCalls = { run: [], build: 0, buildBaseline: 0, t0: [], turnGate: 0 }
  const counters = new Map<string, number>()
  const next = (checkId: string, tier: CheckResult["tier"]): CheckResult => {
    const states = script.results?.[checkId] ?? ["pass"]
    const index = counters.get(checkId) ?? 0
    counters.set(checkId, index + 1)
    const state = states[Math.min(index, states.length - 1)]!
    return { checkId, tier, state, ...(state === "pass" ? {} : { reason: `${checkId} ${state} (fixture)` }), at: "2026-10-02T10:00:00.000Z", runId: STEP_RUN_ID }
  }
  const checks = {
    run: async (checkId: string, input: unknown) => {
      calls.run.push({ checkId, input })
      return next(checkId, "S")
    },
    build: async () => {
      calls.build += 1
      return script.build?.[Math.min(calls.build - 1, script.build.length - 1)] ?? { ok: true, failureSignature: [], durationMs: 1 }
    },
    buildBaseline: async () => {
      calls.buildBaseline += 1
      return script.baseline ?? { ok: true, failureSignature: [], durationMs: 1 }
    },
    t0: async (scenarios: readonly T0Scenario[]) => {
      calls.t0.push([...scenarios])
      return scenarios.map((scenario) => next(scenario.checkId, "T0"))
    },
    turnGate: async (...args: Parameters<CheckRunner["turnGate"]>) => {
      calls.turnGate += 1
      return script.gate ? script.gate(...args) : []
    }
  }
  return { checks: checks as unknown as CheckRunner, calls }
}

export function fakeRegistry(options: { notNeededAgrees?: boolean } = {}) {
  const briefs: string[] = []
  const registry: JobRegistry = {
    seedCandidates: () => [],
    applyApprovals: (candidates) => [...candidates],
    allowedFiles: (item) => item.allow,
    brief: (items) => {
      const text = `BRIEF for ${items.map((item) => item.id).join(", ")}`
      briefs.push(text)
      return text
    },
    // Like the real registry: the item's own checks (agentItem seeds them), per tier.
    checksFor: (item, tier) => item.checks.filter((check) => check.tier === tier).map((check) => ({ tier: check.tier, checkId: check.id })),
    apply: (items, results) =>
      items.map((item) => ({
        ...item,
        checks: results.map((result) => ({ id: result.checkId, tier: result.tier, state: result.state, at: result.at, ...(result.runId ? { runId: result.runId } : {}) }))
      })),
    reverifyNotNeeded: () => (options.notNeededAgrees ? { agrees: true, evidence: [] } : { agrees: false, evidence: [{ file: "app/api/signup/route.ts", line: 12 }] })
  }
  return { registry, briefs }
}

export function fakeInstaller() {
  const recorded: WizardEditRecord[][] = []
  const installer = {
    scan: async ({ root }: { root: string }) => ({ root, appRoot: ".", framework: "next-app", packageManager: "npm", fileCount: 10, truncated: false }),
    recordEdits: async (edits: readonly WizardEditRecord[]) => {
      recorded.push([...edits])
    },
    artifactsFromKeys: () => ({}) as never
  }
  return { installer: installer as unknown as Installer, recorded }
}

export function fakeFs() {
  const fs: WizardDeps["fs"] = {
    readText: async (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
    writeTextAtomic: async (path, text, mode) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text, { mode: mode ?? 0o600 })
    },
    exists: async (path) => existsSync(path),
    mkdirp: async (path, mode) => {
      mkdirSync(path, { recursive: true, mode })
    }
  }
  return fs
}

export function makeDeps(parts: {
  bridge: TagBridgeClient
  agents: AgentRunner
  checks?: CheckRunner
  registry?: JobRegistry
  installer?: Installer
  env?: Record<string, string>
  remoteUrl?: string | null
  /** The working tree's uncommitted paths (the agent step checks it before it starts the cloud run). */
  dirtyPaths?: string[]
}): WizardDeps {
  let now = Date.parse("2026-10-02T10:00:00.000Z")
  return {
    bridge: parts.bridge,
    agents: parts.agents,
    git: {
      remoteUrl: async () => parts.remoteUrl ?? "git@github.com:Acme/acme-store.git",
      isRepo: async () => true,
      cleanTree: async () => ({ clean: (parts.dirtyPaths ?? []).length === 0, dirtyPaths: parts.dirtyPaths ?? [] })
    } as unknown as WizardDeps["git"],
    host: {} as WizardDeps["host"],
    checks: parts.checks ?? fakeChecks().checks,
    registry: parts.registry ?? fakeRegistry().registry,
    installer: parts.installer ?? fakeInstaller().installer,
    report: {} as WizardDeps["report"],
    fs: fakeFs(),
    clock: {
      now: () => new Date((now += 1000)),
      sleep: async () => undefined
    },
    env: parts.env ?? {},
    platform: "darwin",
    tagVersion: "0.0.0-test"
  }
}

export function agentItem(id: string, files: string[], create: string[] = []): ChecklistItem {
  const [jobId] = id.split(":") as [ChecklistItem["jobId"]]
  return {
    id,
    jobId,
    n: 1,
    title: `Job ${id}`,
    owner: "agent",
    trigger: { finding: "fixture", evidence: [{ file: files[0] ?? "app/page.tsx", line: 1 }] },
    allow: { files, create },
    // The checks the real registry seeds for a static-HTML / Vite site (T0 click test; §3e.1 + B15's P check),
    // and an S + B pair for every other job.
    checks:
      jobId === "conversions_to_tools"
        ? [
            { id: "click_test", tier: "T0", state: "not_run" },
            { id: "no_fbq_standard_on_click", tier: "S", state: "not_run" },
            { id: "first_real_conversion", tier: "P", state: "not_run" }
          ]
        : [
            { id: `${jobId}_static`, tier: "S", state: "not_run" },
            { id: "build", tier: "B", state: "not_run" }
          ],
    state: "pending"
  }
}
