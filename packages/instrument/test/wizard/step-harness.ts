// A WizardContext + WizardDeps for testing ONE step against fakes (lane O2's `link`, `keys`, `settings`).
// Every dep a step should not touch throws when used, so a test fails loudly if a step reaches outside its lane.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import type { AskKind, AskPayloads } from "../../src/wizard/contracts/asks.js"
import type { TagBridgeClient } from "../../src/wizard/contracts/bridge.js"
import type { Clock, WizardContext, WizardDeps, WizardFs, WizardOptions } from "../../src/wizard/contracts/deps.js"
import type { WizardEventFields, WizardEventType } from "../../src/wizard/contracts/events.js"
import { WIZARD_STATE_SCHEMA, type WizardRunState } from "../../src/wizard/contracts/state.js"

export const nodeWizardFs: WizardFs = {
  async readText(path) {
    try {
      return await readFile(path, "utf8")
    } catch {
      return null
    }
  },
  async writeTextAtomic(path, text, mode = 0o600) {
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, text, { mode })
    await rename(temp, path)
  },
  async exists(path) {
    try {
      await readFile(path)
      return true
    } catch {
      return false
    }
  },
  async mkdirp(path, mode = 0o700) {
    await mkdir(path, { recursive: true, mode })
  }
}

export function freshState(root: string, change: Partial<WizardRunState> = {}): WizardRunState {
  return {
    schema: WIZARD_STATE_SCHEMA,
    runId: null,
    displayId: "r-7f3c",
    createdAt: "2026-10-02T09:00:00.000Z",
    tagVersion: "0.12.0",
    root,
    appRoot: ".",
    link: null,
    steps: {},
    agent: null,
    git: null,
    pr: null,
    plan: null,
    jobs: [],
    markers: { before: {}, rehearsal: {}, prove: {} },
    report: { live_today: null, in_pr: null, proven_live: null },
    snapshot: null,
    ...change
  }
}

export interface RecordedAsk {
  kind: AskKind
  payload: unknown
  options: Record<string, unknown> | undefined
  /** True once the step closed the ask through its signal. */
  closedByStep: boolean
}

/** Answers per ask, in order. A function gets the payload; "pending" never answers (until the step closes it). */
export type ScriptedAnswer = unknown | "pending" | ((payload: unknown) => unknown)

export interface HarnessOptions {
  root: string
  appRoot?: string
  state?: WizardRunState
  runId?: string | null
  answers?: ScriptedAnswer[]
  options?: Partial<WizardOptions>
  /** Each call to now() advances by this many ms (to drive deadlines). Default 0. */
  clockStepMs?: number
}

export interface Harness {
  ctx: WizardContext
  events: Array<{ type: WizardEventType; fields: unknown }>
  asks: RecordedAsk[]
  saves: number
  state(): WizardRunState
  subs(): string[]
}

export function makeContext(options: HarnessOptions): Harness {
  let state = options.state ?? freshState(options.root)
  const events: Harness["events"] = []
  const asks: RecordedAsk[] = []
  const answers = [...(options.answers ?? [])]
  let nowMs = Date.parse("2026-10-02T09:00:00.000Z")
  const harness: Harness = {
    events,
    asks,
    saves: 0,
    state: () => state,
    subs: () => events.filter((event) => event.type === "step.sub").map((event) => (event.fields as { text: string }).text),
    ctx: {
      runId: options.runId ?? null,
      state: {
        get: () => state,
        update: (mutate) => {
          const next = structuredClone(state)
          mutate(next)
          state = next
        },
        save: async () => {
          harness.saves += 1
        }
      },
      emit: {
        emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]) {
          events.push({ type, fields })
        }
      },
      ask: (async <K extends AskKind>(kind: K, payload: AskPayloads[K], askOptions?: Record<string, unknown>) => {
        const record: RecordedAsk = { kind, payload, options: askOptions, closedByStep: false }
        asks.push(record)
        const signal = askOptions?.signal as AbortSignal | undefined
        const scripted = answers.length > 0 ? answers.shift() : "pending"
        if (scripted === "pending") {
          return new Promise((resolve) => {
            if (!signal) return
            const close = () => {
              record.closedByStep = true
              resolve("__cancelled__")
            }
            if (signal.aborted) close()
            else signal.addEventListener("abort", close, { once: true })
          })
        }
        return typeof scripted === "function" ? (scripted as (p: unknown) => unknown)(payload) : scripted
      }) as WizardContext["ask"],
      signal: new AbortController().signal,
      options: {
        json: false,
        yes: false,
        answersFile: null,
        resume: false,
        noAgent: false,
        worker: null,
        reviewer: null,
        consentMode: null,
        noProve: false,
        nested: false,
        ...options.options
      },
      root: options.root,
      appRoot: options.appRoot ?? ".",
      now: () => {
        const current = new Date(nowMs)
        nowMs += options.clockStepMs ?? 0
        return current
      }
    }
  }
  return harness
}

function unexpected(name: string): never {
  throw new Error(`step reached outside its lane: deps.${name}`)
}

const throwing = <T extends object>(name: string, overrides: Partial<Record<keyof T, unknown>> = {}): T =>
  new Proxy({} as T, {
    get: (_target, property) => {
      if (property === "then") return undefined
      if (property in overrides) return (overrides as Record<string | symbol, unknown>)[property]
      return () => unexpected(`${name}.${String(property)}`)
    }
  })

export interface DepsOptions {
  bridge: TagBridgeClient
  remoteUrl?: string | null
  agentAlive?: boolean
  fs?: WizardFs
}

export const instantClock: Clock = {
  now: () => new Date("2026-10-02T09:00:00.000Z"),
  sleep: async () => undefined
}

export function makeDeps(options: DepsOptions): WizardDeps {
  return {
    bridge: options.bridge,
    agents: throwing<WizardDeps["agents"]>("agents", { isAgentAlive: () => options.agentAlive === true }),
    git: throwing<WizardDeps["git"]>("git", {
      remoteUrl: async () => (options.remoteUrl === undefined ? "git@github.com:acme/acme-store.git" : options.remoteUrl)
    }),
    host: throwing("host"),
    checks: throwing("checks"),
    registry: throwing("registry"),
    installer: throwing("installer"),
    report: throwing("report"),
    fs: options.fs ?? nodeWizardFs,
    clock: instantClock,
    env: {},
    platform: "darwin",
    tagVersion: "0.12.0-test"
  }
}
