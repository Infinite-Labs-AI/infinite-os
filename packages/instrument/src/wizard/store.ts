// The wizard's renderer-agnostic store: one snapshot a UI draws a frame from, a version counter that
// bumps on every change, `subscribe` / `getSnapshot`, ONE pending ask at a time, gates that latch once,
// and the sub-status throttle (§3d.2: at most one `step.sub` per 3 s per step, at most 8 kept).
//
// Adapted from PostHog wizard v2.74.1, MIT, Copyright (c) 2025 PostHog (`ui/tui/store.ts`: the
// version counter + subscribe/getSnapshot pair a UI reads through, the single pending question that
// throws on a second request, and gates that resolve once and stay resolved). PostHog's MIT notice is
// in this package's LICENSE.
//
// Lane O1 publishes the store; lane O2's TTY and JSON UIs read it through `WizardStoreSnapshot` (F0)
// and answer asks through `answerAsk` / `cancelAsk`. Nothing here renders and nothing here does I/O.
import { randomUUID } from "node:crypto"

import { ASK_CANCELLED, type AskKind } from "./contracts/asks.js"
import type { RuntimeVariant } from "./contracts/bridge.js"
import type { WizardCode } from "./contracts/codes.js"
import { EVENT_LIMITS } from "./contracts/events.js"
import type { StoreStepRow, WizardStoreSnapshot } from "./contracts/state.js"
import { WIZARD_STEP_IDS, WIZARD_STEP_META, type StepOutcomeKind, type WizardStepId } from "./contracts/steps.js"

export type SubTone = "ok" | "warn" | "info" | "pending" | "result"

/** Narration lines kept in the snapshot (the TUI shows the last few). */
export const STORE_NARRATION_KEPT = 8

const settledJobState = (state: NonNullable<WizardStoreSnapshot["jobs"]>[number]["state"]): boolean =>
  state === "done_in_code" || state === "waiting_deploy" || state === "waiting_real_event" || state === "proven" || state === "not_needed" || state === "left_for_you" || state === "failed" || state === "blocked"

export function jobDisplayState(state: string, by: "agent_claim" | "wizard" = "wizard"): NonNullable<WizardStoreSnapshot["jobs"]>[number]["state"] {
  if (state === "pending") return "waiting"
  if (state === "claimed") return by === "wizard" ? "could_not_check" : "agent_claim"
  if (state === "done_in_code" || state === "waiting_deploy" || state === "waiting_real_event" || state === "proven" || state === "not_needed" || state === "left_for_you" || state === "failed" || state === "blocked") return state
  return "waiting"
}

export class StoreAskConflictError extends Error {
  constructor(pendingKind: AskKind, requestedKind: AskKind) {
    super(`An ask is already open (${pendingKind}); a second ask (${requestedKind}) cannot open until it closes.`)
    this.name = "StoreAskConflictError"
  }
}

interface PendingAsk {
  askId: string
  kind: AskKind
  payload: unknown
  resolve(answer: unknown): void
}

interface Gate {
  promise: Promise<void>
  resolve(): void
  resolved: boolean
}

export interface WizardStoreOptions {
  displayId: string
  tagVersion: string
  now?: () => Date
}

/**
 * The store. Every mutation goes through a method so the version always bumps and listeners always
 * hear about it; `getSnapshot()` returns an immutable copy-on-write object (a new object per version).
 */
export class WizardStore {
  private snapshot: WizardStoreSnapshot
  private readonly listeners = new Set<() => void>()
  private pending: PendingAsk | null = null
  private readonly gates = new Map<string, Gate>()
  private readonly now: () => Date

  constructor(options: WizardStoreOptions) {
    this.now = options.now ?? (() => new Date())
    this.snapshot = {
      version: 0,
      run: { runId: null, displayId: options.displayId, tagVersion: options.tagVersion, runtimeVariant: null },
      steps: WIZARD_STEP_IDS.map((id) => ({
        id,
        title: WIZARD_STEP_META[id].title,
        state: "pending",
        status: null,
        code: null,
        subs: []
      })),
      currentStep: null,
      learn: null,
      narration: [],
      jobs: [],
      jobsSettledHighWater: 0,
      pendingAsk: null,
      outro: null,
      exit: null
    }
  }

  // ---- reading ----

  /** A new object per version; never mutated after it is handed out. */
  getSnapshot(): WizardStoreSnapshot {
    return this.snapshot
  }

  get version(): number {
    return this.snapshot.version
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ---- run ----

  setRun(patch: Partial<WizardStoreSnapshot["run"]>): void {
    this.commit({ run: { ...this.snapshot.run, ...patch } })
  }

  setRuntimeVariant(variant: RuntimeVariant | null): void {
    this.setRun({ runtimeVariant: variant })
  }

  // ---- steps ----

  stepStart(step: WizardStepId): void {
    this.commit({
      currentStep: step,
      ...(step === "jobs" ? { jobs: [], jobsSettledHighWater: 0 } : {}),
      // An agent's last line belongs to the step it was said in: a new step starts with none (terminal QA #19).
      narration: [],
      learn: WIZARD_STEP_META[step].learn,
      steps: this.mapStep(step, (row) => ({ ...row, state: "running", status: null, code: null, startedAt: this.now().toISOString() }))
    })
  }

  stepStatus(step: WizardStepId, text: string): void {
    this.commit({ steps: this.mapStep(step, (row) => ({ ...row, status: text })) })
  }

  /** Appends one released sub-status (the throttle in events.ts decides WHEN a sub is released). */
  stepSub(step: WizardStepId, text: string, tone: SubTone): void {
    const at = this.now().toISOString()
    this.commit({
      steps: this.mapStep(step, (row) => ({
        ...row,
        subs: [...row.subs, { text, tone, at }].slice(-EVENT_LIMITS.subKeptPerStep)
      }))
    })
  }

  stepDone(step: WizardStepId, outcome: StepOutcomeKind, code: WizardCode | null, reason: string | null): void {
    this.commit({
      steps: this.mapStep(step, (row) => ({
        ...row,
        state: outcome,
        code,
        status: reason ?? row.status
      }))
    })
  }

  jobSeeded(item: { id: string; title: string; state: string; note?: string }): void {
    const jobs = this.snapshot.jobs ?? []
    if (jobs.some((row) => row.id === item.id)) return
    const next = [...jobs, { id: item.id, title: item.title, state: jobDisplayState(item.state), ...(item.note ? { note: item.note } : {}) }]
    this.commit({ jobs: next, jobsSettledHighWater: Math.max(this.snapshot.jobsSettledHighWater ?? 0, next.filter((row) => settledJobState(row.state)).length) })
  }

  jobDisplay(itemId: string, state: NonNullable<WizardStoreSnapshot["jobs"]>[number]["state"], note?: string): void {
    const jobs = (this.snapshot.jobs ?? []).map((row) => row.id === itemId ? { ...row, state, note } : row)
    const settled = jobs.filter((row) => settledJobState(row.state)).length
    this.commit({ jobs, jobsSettledHighWater: Math.max(this.snapshot.jobsSettledHighWater ?? 0, settled) })
  }

  // ---- narration ----

  narrate(agent: "claude_code" | "codex", role: "worker" | "reviewer", text: string): void {
    const at = this.now().toISOString()
    this.commit({ narration: [...this.snapshot.narration, { agent, role, text, at }].slice(-STORE_NARRATION_KEPT) })
  }

  // ---- asks: at most one pending ----

  /**
   * Opens the one pending ask and resolves with whatever the UI answers (or a non-answer). A second ask
   * while one is pending throws: asks are serial by design, so a second one is a programming error.
   */
  openAsk(kind: AskKind, payload: unknown, askId: string = `ask_${randomUUID()}`): { askId: string; answer: Promise<unknown> } {
    if (this.pending) throw new StoreAskConflictError(this.pending.kind, kind)
    let resolve!: (answer: unknown) => void
    const answer = new Promise<unknown>((done) => {
      resolve = done
    })
    this.pending = { askId, kind, payload, resolve }
    this.commit({ pendingAsk: { askId, kind, payload } })
    return { askId, answer }
  }

  /** The UI's answer. Returns false (and changes nothing) for an unknown or already-closed ask id. */
  answerAsk(askId: string, answer: unknown): boolean {
    const pending = this.pending
    if (!pending || pending.askId !== askId) return false
    this.pending = null
    this.commit({ pendingAsk: null })
    pending.resolve(answer)
    return true
  }

  /** ESC / Ctrl+C on the overlay, or the run aborting: closes the ask with `__cancelled__`. */
  cancelAsk(askId?: string): boolean {
    const pending = this.pending
    if (!pending || (askId !== undefined && pending.askId !== askId)) return false
    return this.answerAsk(pending.askId, ASK_CANCELLED)
  }

  get pendingAskId(): string | null {
    return this.pending?.askId ?? null
  }

  // ---- gates: resolve once, stay resolved ----

  /** A promise that resolves when `openGate(name)` is called (now or later). Resolved gates stay resolved. */
  gate(name: string): Promise<void> {
    return this.ensureGate(name).promise
  }

  openGate(name: string): void {
    const gate = this.ensureGate(name)
    if (gate.resolved) return
    gate.resolved = true
    gate.resolve()
    this.commit({})
  }

  isGateOpen(name: string): boolean {
    return this.gates.get(name)?.resolved ?? false
  }

  // ---- end of run ----

  /** What the Learn cards may name (the site, the workspace, the two agents); merged, never cleared by a step. */
  setLearnFacts(patch: NonNullable<WizardStoreSnapshot["learnFacts"]>): void {
    const next = { ...(this.snapshot.learnFacts ?? {}), ...patch }
    const before = JSON.stringify(this.snapshot.learnFacts ?? {})
    if (JSON.stringify(next) !== before) this.commit({ learnFacts: next })
  }

  setOutro(text: string | null): void {
    this.commit({ outro: text })
  }

  setExit(exit: WizardStoreSnapshot["exit"]): void {
    this.commit({ exit })
  }

  // ---- internals ----

  private ensureGate(name: string): Gate {
    let gate = this.gates.get(name)
    if (!gate) {
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      gate = { promise, resolve, resolved: false }
      this.gates.set(name, gate)
    }
    return gate
  }

  private mapStep(step: WizardStepId, update: (row: StoreStepRow) => StoreStepRow): StoreStepRow[] {
    return this.snapshot.steps.map((row) => (row.id === step ? update(row) : row))
  }

  private commit(patch: Partial<WizardStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, version: this.snapshot.version + 1 }
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A UI listener that throws must never break the run; the UI owns its own errors.
      }
    }
  }
}
