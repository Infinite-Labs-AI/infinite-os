// §3d.8 of the wizard build plan (the steps interface) as code: StepOutcome, WizardStep,
// WizardContext and WizardDeps. Every step file (`src/wizard/steps/<id>.ts`) exports
// `step: WizardStep<"<id>">`; the engine (lane O1) runs them through a Record keyed by WizardStepId.
// Lanes get every collaborator through WizardDeps, so each one tests against fakes, never against a
// sibling lane's unmerged code.
import type { AgentRunner } from "./agents.js"
import type { AskAnswer, AskKind, AskPayloads } from "./asks.js"
import type { TagBridgeClient, TagCapability } from "./bridge.js"
import type { WizardCode } from "./codes.js"
import type { WizardEventFields, WizardEventType } from "./events.js"
import type { GitHostAdapter, GitOps } from "./git-host.js"
import type { CheckRunner, Installer, JobRegistry } from "./jobs.js"
import type { ReportBuilder } from "./report.js"
import type { WizardRunState } from "./state.js"
import type { LearnId, WizardStepId, Who } from "./steps.js"

/**
 * §3d.8 + §3z.12 (B3): `blocked` HALTS the run and its code sets the exit code (link's NO_APP / SIGNED_OUT,
 * FENCE_TAMPER); `failed` with `next:"continue"` does not.
 */
export type StepOutcome =
  | { kind: "ok"; status: string }
  | { kind: "skipped"; reason: string }
  | { kind: "parked"; code: WizardCode; reason: string; resumeHint: string }
  | { kind: "blocked"; code: WizardCode; reason: string }
  | { kind: "failed"; code: WizardCode; message: string; next: "halt" | "continue" }

/** The wizard's flags (lane O1's `command.ts` parses them). */
export interface WizardOptions {
  json: boolean
  yes: boolean
  answersFile: string | null
  resume: boolean
  noAgent: boolean
  worker: "claude" | "codex" | null
  reviewer: "claude" | "codex" | "brief" | "none" | null
  consentMode: "not_required" | "required" | null
  noProve: boolean
  /** Launched by an agent (a nesting marker is set and there is no TTY): §3d.7. */
  nested: boolean
}

/** Read and update the run state; `save` writes state.json atomically (0600). */
export interface RunStateAccessor {
  get(): Readonly<WizardRunState>
  update(mutate: (state: WizardRunState) => void): void
  save(): Promise<void>
}

/** Emits §3d.2 events to the store (and the NDJSON writer in --json mode). Throttling is the emitter's job. */
export interface WizardEmitter {
  emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]): void
}

/**
 * Opens ONE ask (a second while one is pending throws) and resolves with the answer or a non-answer.
 * `signal` closes the ask from the step's side (`__cancelled__`): a display-only ask such as `link-code`
 * has no answer, so the step that opened it aborts the signal once it is over (§3d.8 amendment, O1 fix
 * round, O1-01).
 */
export type AskFn = <K extends AskKind>(
  kind: K,
  payload: AskPayloads[K],
  options?: { timeoutMs?: number; signal?: AbortSignal }
) => Promise<AskAnswer<K>>

export interface WizardContext {
  /** The cloud run id; null until the `agent` step creates it. */
  runId: string | null
  state: RunStateAccessor
  emit: WizardEmitter
  ask: AskFn
  signal: AbortSignal
  options: WizardOptions
  root: string
  appRoot: string
  now(): Date
}

/** The file system the steps use (so tests can fake it). Paths are absolute. */
export interface WizardFs {
  readText(path: string): Promise<string | null>
  /** temp + rename; `mode` defaults to 0600 for files under `.infinite/wizard/`. */
  writeTextAtomic(path: string, text: string, mode?: number): Promise<void>
  exists(path: string): Promise<boolean>
  mkdirp(path: string, mode?: number): Promise<void>
  /**
   * B29: deletes a file only while its sha256 is still `expectedSha256` (`sha256:<hex>`) — e.g. a file an agent
   * created in a fix round that failed the wizard's checks. Returns false (and deletes nothing) on a mismatch
   * or a missing file. Optional for fakes.
   */
  removeFile?(path: string, expectedSha256: string): Promise<boolean>
}

export interface Clock {
  now(): Date
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface WizardDeps {
  bridge: TagBridgeClient
  agents: AgentRunner
  git: GitOps
  host: GitHostAdapter
  checks: CheckRunner
  registry: JobRegistry
  installer: Installer
  report: ReportBuilder
  fs: WizardFs
  clock: Clock
  env: Readonly<Record<string, string | undefined>>
  platform: string
  tagVersion: string
  /** B29: opens a URL in the user's browser (darwin TTY runs only; absent elsewhere and in tests). */
  openUrl?(url: string): Promise<void>
}

/** §3d.8. One per step file. */
export interface WizardStep<Id extends WizardStepId> {
  id: Id
  title: string
  who: Who[]
  learn: LearnId
  requiredCapabilities: TagCapability[]
  /** sha256 of the step's declared inputs (e.g. `plan`: scan summary + keys + answers; `rehearsal`: the head SHA). */
  inputHash(ctx: WizardContext): string
  run(ctx: WizardContext, deps: WizardDeps): Promise<StepOutcome>
}

/** The Record the engine runs (a missing step id does not compile). */
export type WizardStepRecord = { readonly [Id in WizardStepId]: WizardStep<Id> }
