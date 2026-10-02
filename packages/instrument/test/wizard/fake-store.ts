// Test doubles for the UI side of the wizard (lane O2): a store that implements the WizardStoreView seam O1's
// WizardStore fills, snapshot builders, a stand-in for O3's sanitizeUntrusted, and fake stdin/stdout streams.
import { EventEmitter } from "node:events"

import type { WizardStoreSnapshot, StoreStepRow } from "../../src/wizard/contracts/state.js"
import { WIZARD_STEP_IDS, WIZARD_STEP_META, type WizardStepId } from "../../src/wizard/contracts/steps.js"
import type { WizardStoreView } from "../../src/tui/ui.js"

/**
 * Stand-in for lane O3's `sanitizeUntrusted(text, max)` (src/agents/sanitize.ts is O3's file, not on this
 * lane's base). It strips ESC/C0/C1 controls and bidi overrides and caps the length, and records every call
 * so tests can prove the UI routed a string through the sanitiser.
 */
export function makeTestSanitizer(): ((text: string, max: number) => string) & { calls: string[] } {
  const calls: string[] = []
  const fn = ((text: string, max: number) => {
    calls.push(text)
    // eslint-disable-next-line no-control-regex
    const clean = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    return Array.from(clean).slice(0, max).join("")
  }) as ((text: string, max: number) => string) & { calls: string[] }
  fn.calls = calls
  return fn
}

export function stepRows(states: Partial<Record<WizardStepId, Partial<StoreStepRow>>> = {}): StoreStepRow[] {
  return WIZARD_STEP_IDS.map((id) => ({
    id,
    title: WIZARD_STEP_META[id].title,
    state: "pending",
    status: null,
    code: null,
    subs: [],
    ...states[id]
  }))
}

export function makeSnapshot(change: Partial<WizardStoreSnapshot> = {}): WizardStoreSnapshot {
  return {
    version: 1,
    run: { runId: "7f3c2a91-b0de-4c5f-8a21-3e4d5c6b7a80", displayId: "r-7f3c", tagVersion: "0.12.0", runtimeVariant: "prod" },
    steps: stepRows(),
    currentStep: null,
    learn: null,
    narration: [],
    pendingAsk: null,
    outro: null,
    exit: null,
    ...change
  }
}

/** A mid-run snapshot like the design's: steps 0–5 done, `jobs` running with narration and sub-statuses. */
export function midRunSnapshot(change: Partial<WizardStoreSnapshot> = {}): WizardStoreSnapshot {
  const at = "2026-10-02T09:12:00.000Z"
  return makeSnapshot({
    steps: stepRows({
      link: { state: "ok", status: "Linked: github.com/acme/acme-store → workspace Acme" },
      agent: { state: "ok", status: "Claude Code does the work · Codex reviews it" },
      before: { state: "ok", status: "Before: 6 pass · 5 problems · 3 unknown" },
      keys: { state: "ok", status: "Keys from Infinite · nothing to paste" },
      plan: { state: "ok", status: "Plan approved" },
      install: { state: "ok", status: "6 files written · build passes" },
      jobs: {
        state: "running",
        subs: [
          { text: "Job 1/7 · Server-side sign-up event", tone: "info", at },
          { text: "Job 2/7 · Improve the existing PostHog (proxy, page changes)", tone: "info", at },
          { text: "Job 3/7 · Remove the second GA4 tag", tone: "info", at },
          { text: "✓ Job 1 checked by the wizard", tone: "info", at },
          { text: "! Job 3 needs a second look", tone: "info", at },
          { text: "Wizard checking each job itself…", tone: "pending", at }
        ]
      }
    }),
    currentStep: "jobs",
    learn: "checklist",
    narration: [
      {
        agent: "claude_code",
        role: "worker",
        text: "The sign-up route already creates the user, so I'm adding the server-side sign-up event right after that.",
        at
      }
    ],
    ...change
  })
}

export class FakeStore implements WizardStoreView {
  snapshot: WizardStoreSnapshot
  readonly answers: Array<{ askId: string; answer: unknown }> = []
  private listeners = new Set<() => void>()

  constructor(snapshot: WizardStoreSnapshot = makeSnapshot()) {
    this.snapshot = snapshot
  }

  getSnapshot(): WizardStoreSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  answerAsk(askId: string, answer: unknown): void {
    if (this.snapshot.pendingAsk?.askId !== askId) throw new Error(`FakeStore: no pending ask ${askId}`)
    this.answers.push({ askId, answer })
    this.set({ pendingAsk: null })
  }

  set(change: Partial<WizardStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change, version: this.snapshot.version + 1 }
    for (const listener of this.listeners) listener()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}

/** A fake TTY stdin: records raw-mode changes; `type()` feeds keys; `fail()` raises a stream error. */
export class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  readonly rawModes: boolean[] = []
  setRawMode(mode: boolean): this {
    this.rawModes.push(mode)
    this.isRaw = mode
    return this
  }
  setEncoding(): this {
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  type(chunk: string): void {
    this.emit("data", chunk)
  }
  fail(code: string): void {
    const error = Object.assign(new Error(`read ${code}`), { code })
    this.emit("error", error)
  }
}

export class FakeStdout extends EventEmitter {
  isTTY = true
  columns: number
  rows: number
  readonly chunks: string[] = []
  constructor(columns = 120, rows = 40) {
    super()
    this.columns = columns
    this.rows = rows
  }
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  get text(): string {
    return this.chunks.join("")
  }
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
