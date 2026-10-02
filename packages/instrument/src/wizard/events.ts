// The §3d.2 event emitter: every event goes to the store (what the UI draws) and, in `--json` mode,
// out as one NDJSON line `{v:1, t, at, …fields}`.
//
// The sub-status throttle lives here (§3d.2: ≤1 `step.sub` per 3 s per step, ≤8 kept): the wizard's
// live updates are "a little magical, not real-time everything". Progress subs (`info`, `pending`)
// coalesce: only the newest waiting one is shown when the window opens. Result subs (`ok`, `warn`)
// are never dropped: they queue and release one per window, and `step.done` flushes the queue at once
// so a step never finishes with a result still hidden. Text is capped and stripped of terminal
// control sequences before it reaches the store or stdout.
import type { WizardEmitter } from "./contracts/deps.js"
import {
  EVENT_LIMITS,
  WIZARD_EVENT_VERSION,
  type WizardEvent,
  type WizardEventFields,
  type WizardEventType
} from "./contracts/events.js"
import type { WizardStepId } from "./contracts/steps.js"
import type { SubTone, WizardStore } from "./store.js"

/** A timer seam so tests drive the throttle with a fake clock. */
export interface EmitterTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const REAL_TIMERS: EmitterTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // A pending sub must never keep the process alive after the run ended.
    if (typeof handle === "object" && handle && "unref" in handle) (handle as { unref(): void }).unref()
    return handle
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

// ANSI CSI/OSC sequences, C0/C1 controls (except none: newlines are flattened too) and bidi overrides.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g
const BIDI_PATTERN = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/**
 * The emitter's own text hygiene: strip ANSI, C0/C1 controls and bidi overrides, collapse whitespace,
 * cap at `max` (with an ellipsis). Untrusted agent text is ALSO passed through lane O3's
 * `sanitizeUntrusted` by its producer; this is the last line before a terminal or stdout.
 */
export function cleanEventText(text: string, max: number): string {
  const flat = String(text)
    .replace(ANSI_PATTERN, "")
    .replace(BIDI_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export interface WizardEventEmitterOptions {
  store: WizardStore
  /** `--json` mode: one NDJSON line per event (without the trailing newline; the writer adds it). */
  ndjson?: ((line: string) => void) | null
  now?: () => Date
  timers?: EmitterTimers
  /** Every event as emitted (after the throttle), for tests and the run log. */
  onEvent?: (event: WizardEvent) => void
}

interface SubThrottle {
  lastReleasedAt: number | null
  queue: Array<{ text: string; tone: SubTone }>
  latestProgress: { text: string; tone: SubTone } | null
  timer: unknown
}

export class WizardEventEmitter implements WizardEmitter {
  private readonly store: WizardStore
  private readonly ndjson: ((line: string) => void) | null
  private readonly now: () => Date
  private readonly timers: EmitterTimers
  private readonly onEvent: ((event: WizardEvent) => void) | null
  private readonly subs = new Map<WizardStepId, SubThrottle>()

  constructor(options: WizardEventEmitterOptions) {
    this.store = options.store
    this.ndjson = options.ndjson ?? null
    this.now = options.now ?? (() => new Date())
    this.timers = options.timers ?? REAL_TIMERS
    this.onEvent = options.onEvent ?? null
  }

  emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]): void {
    switch (type) {
      case "step.sub": {
        const sub = fields as WizardEventFields["step.sub"]
        this.queueSub(sub.step, cleanEventText(sub.text, EVENT_LIMITS.subTextMaxChars), sub.tone)
        return
      }
      case "step.done": {
        const done = fields as WizardEventFields["step.done"]
        this.flushSubs(done.step)
        this.store.stepDone(done.step, done.outcome, done.code ?? null, done.reason ?? null)
        break
      }
      case "run.start": {
        const start = fields as WizardEventFields["run.start"]
        this.store.setRun({ runId: start.runId, displayId: start.displayId, tagVersion: start.tagVersion })
        break
      }
      case "step.start":
        this.store.stepStart((fields as WizardEventFields["step.start"]).step)
        break
      case "step.status": {
        const status = fields as WizardEventFields["step.status"]
        const text = cleanEventText(status.text, EVENT_LIMITS.statusTextMaxChars)
        this.store.stepStatus(status.step, text)
        this.write("step.status", { ...status, text })
        return
      }
      case "narrate": {
        const beat = fields as WizardEventFields["narrate"]
        const text = cleanEventText(beat.text, EVENT_LIMITS.narrateTextMaxChars)
        this.store.narrate(beat.agent, beat.role, text)
        this.write("narrate", { ...beat, text })
        return
      }
      case "run.end": {
        const end = fields as WizardEventFields["run.end"]
        for (const step of this.subs.keys()) this.flushSubs(step)
        this.store.setExit({ exitCode: end.exitCode, prUrl: end.prUrl ?? null, reportPath: end.reportPath })
        break
      }
      default:
        break
    }
    this.write(type, fields)
  }

  /** Releases every waiting sub now (result subs in order; a stale progress sub is dropped). */
  flushSubs(step: WizardStepId): void {
    const throttle = this.subs.get(step)
    if (!throttle) return
    if (throttle.timer !== null) {
      this.timers.clear(throttle.timer)
      throttle.timer = null
    }
    while (throttle.queue.length > 0) this.releaseSub(step, throttle, throttle.queue.shift()!)
    throttle.latestProgress = null
  }

  /** Stops every pending timer (end of run). */
  dispose(): void {
    for (const throttle of this.subs.values()) {
      if (throttle.timer !== null) this.timers.clear(throttle.timer)
      throttle.timer = null
    }
  }

  private queueSub(step: WizardStepId, text: string, tone: SubTone): void {
    let throttle = this.subs.get(step)
    if (!throttle) {
      throttle = { lastReleasedAt: null, queue: [], latestProgress: null, timer: null }
      this.subs.set(step, throttle)
    }
    const nowMs = this.now().getTime()
    const windowOpen = throttle.lastReleasedAt === null || nowMs - throttle.lastReleasedAt >= EVENT_LIMITS.subThrottleMs
    if (windowOpen && throttle.queue.length === 0 && throttle.latestProgress === null) {
      this.releaseSub(step, throttle, { text, tone })
      return
    }
    if (tone === "ok" || tone === "warn") {
      throttle.queue.push({ text, tone })
      // Never more waiting than the store keeps.
      if (throttle.queue.length > EVENT_LIMITS.subKeptPerStep) throttle.queue.shift()
    } else {
      throttle.latestProgress = { text, tone }
    }
    this.schedule(step, throttle)
  }

  private schedule(step: WizardStepId, throttle: SubThrottle): void {
    if (throttle.timer !== null) return
    const elapsed = throttle.lastReleasedAt === null ? EVENT_LIMITS.subThrottleMs : this.now().getTime() - throttle.lastReleasedAt
    const wait = Math.max(0, EVENT_LIMITS.subThrottleMs - elapsed)
    throttle.timer = this.timers.set(() => {
      throttle.timer = null
      const next = throttle.queue.shift() ?? throttle.latestProgress
      if (next === throttle.latestProgress) throttle.latestProgress = null
      if (next) this.releaseSub(step, throttle, next)
      if (throttle.queue.length > 0 || throttle.latestProgress !== null) this.schedule(step, throttle)
    }, wait)
  }

  private releaseSub(step: WizardStepId, throttle: SubThrottle, sub: { text: string; tone: SubTone }): void {
    throttle.lastReleasedAt = this.now().getTime()
    this.store.stepSub(step, sub.text, sub.tone)
    this.write("step.sub", { step, text: sub.text, tone: sub.tone })
  }

  private write<T extends WizardEventType>(type: T, fields: WizardEventFields[T]): void {
    const event = { v: WIZARD_EVENT_VERSION, t: type, at: this.now().toISOString(), ...fields } as unknown as WizardEvent
    this.onEvent?.(event)
    if (this.ndjson) this.ndjson(JSON.stringify(event))
  }
}
