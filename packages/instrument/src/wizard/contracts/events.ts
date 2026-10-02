// §3d.2 of the wizard build plan (the events the wizard emits; NDJSON in `--json` mode, one per line)
// as code, plus the one input line it reads in `--json` mode (`ask.answer`).
//
// NORMATIVE. Every line carries `v:1`, `t` (the event type) and `at`; the event's fields sit beside
// them. Untrusted text (narration, agent text) is sanitized before it is emitted, and capped.
import type { AskKind } from "./asks.js"
import type { WizardCode } from "./codes.js"
import type { ChecklistItem, CheckTier, JobItemState } from "./jobs.js"
import type { ReceiptLane, ReceiptState } from "./receipts.js"
import type { ReportPhase, ReportV2 } from "./report.js"
import { shapeOf, type ObjectShape } from "./shape.js"
import type { StepOutcomeKind, WizardStepId } from "./steps.js"

export const WIZARD_EVENT_VERSION = 1 as const
/** Every key of an event line besides its fields. */
export const WIZARD_EVENT_ENVELOPE_KEYS = ["v", "t", "at"] as const

/** Text caps and the sub-status throttle (§3d.2). */
export const EVENT_LIMITS = {
  subTextMaxChars: 120,
  statusTextMaxChars: 160,
  narrateTextMaxChars: 120,
  /** step.sub: at most one per this many ms per step… */
  subThrottleMs: 3_000,
  /** …and at most this many kept per step. */
  subKeptPerStep: 8
} as const

/** Each event type and its fields (without `v`, `t`, `at`). */
export interface WizardEventFields {
  "run.start": {
    /** Null until the `agent` step creates the cloud run (set on a resume). */
    runId: string | null
    displayId: string
    tagVersion: string
    root: string
    appRoot: string
    resumedFrom?: WizardStepId
  }
  "step.start": { step: WizardStepId }
  "step.sub": { step: WizardStepId; text: string; tone: "ok" | "warn" | "info" | "pending" }
  "step.status": { step: WizardStepId; text: string }
  "step.done": { step: WizardStepId; outcome: StepOutcomeKind; code?: WizardCode; reason?: string }
  narrate: { agent: "claude_code" | "codex"; role: "worker" | "reviewer"; text: string }
  "ask.open": { askId: string; kind: AskKind; payload: unknown }
  "ask.closed": { askId: string; answer: unknown }
  "job.seeded": { item: ChecklistItem }
  "job.state": { itemId: string; state: JobItemState; by: "wizard" | "agent_claim"; checkId?: string; note?: string }
  "check.result": {
    checkId: string
    itemId?: string
    tier: CheckTier
    state: "pass" | "problem" | "undetermined" | "info"
    reason?: string
    runId: string | null
  }
  receipt: { lane: ReceiptLane; state: ReceiptState; receiptAt: string | null; runId: string }
  "tty.handover": { reason: "gpg" | "ssh" | "hook" }
  "tty.resume": Record<never, never>
  report: { phase: ReportPhase; report: ReportV2 }
  "run.end": { exitCode: number; runId: string | null; prUrl?: string; reportPath: string | null }
}

export type WizardEventType = keyof WizardEventFields

export const WIZARD_EVENT_TYPES = [
  "run.start",
  "step.start",
  "step.sub",
  "step.status",
  "step.done",
  "narrate",
  "ask.open",
  "ask.closed",
  "job.seeded",
  "job.state",
  "check.result",
  "receipt",
  "tty.handover",
  "tty.resume",
  "report",
  "run.end"
] as const satisfies readonly WizardEventType[]

/** One NDJSON line. */
export type WizardEvent<T extends WizardEventType = WizardEventType> = T extends WizardEventType
  ? { v: typeof WIZARD_EVENT_VERSION; t: T; at: string } & WizardEventFields[T]
  : never

const e = <T extends WizardEventType>() => shapeOf<WizardEventFields[T]>()

/** Each event type's exact field keys, compile-checked against WizardEventFields (for strict readers and tests). */
export const WIZARD_EVENT_SHAPES: { readonly [T in WizardEventType]: ObjectShape } = {
  "run.start": e<"run.start">()("run.start", ["runId", "displayId", "tagVersion", "root", "appRoot"], ["resumedFrom"]),
  "step.start": e<"step.start">()("step.start", ["step"], []),
  "step.sub": e<"step.sub">()("step.sub", ["step", "text", "tone"], []),
  "step.status": e<"step.status">()("step.status", ["step", "text"], []),
  "step.done": e<"step.done">()("step.done", ["step", "outcome"], ["code", "reason"]),
  narrate: e<"narrate">()("narrate", ["agent", "role", "text"], []),
  "ask.open": e<"ask.open">()("ask.open", ["askId", "kind", "payload"], []),
  "ask.closed": e<"ask.closed">()("ask.closed", ["askId", "answer"], []),
  "job.seeded": e<"job.seeded">()("job.seeded", ["item"], []),
  "job.state": e<"job.state">()("job.state", ["itemId", "state", "by"], ["checkId", "note"]),
  "check.result": e<"check.result">()("check.result", ["checkId", "tier", "state", "runId"], ["itemId", "reason"]),
  receipt: e<"receipt">()("receipt", ["lane", "state", "receiptAt", "runId"], []),
  "tty.handover": e<"tty.handover">()("tty.handover", ["reason"], []),
  "tty.resume": e<"tty.resume">()("tty.resume", [], []),
  report: e<"report">()("report", ["phase", "report"], []),
  "run.end": e<"run.end">()("run.end", ["exitCode", "runId", "reportPath"], ["prUrl"])
}

/** The shape of one full NDJSON event line (the envelope keys plus the type's fields). */
export function wizardEventLineShape(type: WizardEventType): ObjectShape {
  const fields = WIZARD_EVENT_SHAPES[type]
  return { ...fields, required: [...WIZARD_EVENT_ENVELOPE_KEYS, ...fields.required] }
}

/** The one line the wizard reads on stdin in `--json` mode. */
export interface AskAnswerLine {
  v: typeof WIZARD_EVENT_VERSION
  t: "ask.answer"
  askId: string
  answer: unknown
}

