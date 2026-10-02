// The JSON UI (`--json`): the §3d.2 events as NDJSON on stdout, one line each, every line `{"v":1,"t",…,"at"}`;
// and the one input it reads on stdin: `{"v":1,"t":"ask.answer","askId","answer"}` lines, routed to the store's
// pending ask. An answer for any other askId (an unknown one, or one already closed) is rejected on stderr
// and never reaches the store. stdout carries events only.
//
// It is also the NDJSON writer O1's emitter writes to (`emit(type, fields)` implements WizardEmitter): every
// field that can carry outside text (narration, sub-statuses, statuses, reasons, notes, agent questions,
// teammate comments) goes through the injected sanitiser before it is written.
import type { AskKind } from "../wizard/contracts/asks.js"
import {
  EVENT_LIMITS,
  WIZARD_EVENT_SHAPES,
  WIZARD_EVENT_VERSION,
  type AskAnswerLine,
  type WizardEventFields,
  type WizardEventType
} from "../wizard/contracts/events.js"
import { shapeErrors, shapeOf } from "../wizard/contracts/shape.js"
import type { UntrustedSanitizer, WizardStoreView, WizardUi } from "./ui.js"

export interface JsonInput {
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown
  off(event: "data", listener: (chunk: string | Buffer) => void): unknown
  setEncoding?(encoding: BufferEncoding): unknown
  resume?(): unknown
  pause?(): unknown
}

export interface JsonOutput {
  write(chunk: string): unknown
}

export interface JsonUiOptions {
  stdin: JsonInput
  stdout: JsonOutput
  stderr: JsonOutput
  /** Lane O3's sanitizeUntrusted (required: there is no second sanitiser). */
  sanitize: UntrustedSanitizer
  now?: () => Date
}

const ASK_ANSWER_LINE_SHAPE = shapeOf<AskAnswerLine>()("AskAnswerLine", ["v", "t", "askId", "answer"], [])
/** A stdin line longer than this is dropped (an answer is small). */
export const MAX_ANSWER_LINE_BYTES = 1024 * 1024
const NOTE_CAP = 500
const REASON_CAP = 300

export class JsonUi implements WizardUi {
  private store: WizardStoreView | null = null
  private buffer = ""
  private started = false
  private stopped = false
  private readonly onData = (chunk: string | Buffer) => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let newline = this.buffer.indexOf("\n")
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      this.handleLine(line)
      newline = this.buffer.indexOf("\n")
    }
    if (Buffer.byteLength(this.buffer, "utf8") > MAX_ANSWER_LINE_BYTES) {
      this.buffer = ""
      this.reject("dropped a stdin line longer than 1 MB")
    }
  }

  constructor(private readonly options: JsonUiOptions) {}

  start(store: WizardStoreView): void {
    if (this.started) throw new Error("JsonUi.start: already started")
    this.started = true
    this.store = store
    this.options.stdin.setEncoding?.("utf8")
    this.options.stdin.on("data", this.onData)
    this.options.stdin.resume?.()
  }

  stop(): void {
    if (!this.started || this.stopped) return
    this.stopped = true
    this.options.stdin.off("data", this.onData)
    this.options.stdin.pause?.()
  }

  /** The JSON UI prints no outro: the `report` event carries the report. */
  setOutro(text: string | null): void {
    void text
  }

  waitForDismiss(): Promise<void> {
    return Promise.resolve()
  }

  /** Write one event line (WizardEmitter). Throws on fields that do not match the event's exact shape. */
  emit<T extends WizardEventType>(type: T, fields: WizardEventFields[T]): void {
    const clean = this.sanitizeFields(type, fields)
    const errors = shapeErrors(clean, WIZARD_EVENT_SHAPES[type])
    if (errors.length > 0) throw new Error(`json-ui: ${type} event does not match the contract: ${errors[0]}`)
    const at = (this.options.now ?? (() => new Date()))().toISOString()
    this.options.stdout.write(`${JSON.stringify({ v: WIZARD_EVENT_VERSION, t: type, ...clean, at })}\n`)
  }

  private sanitizeFields<T extends WizardEventType>(type: T, fields: WizardEventFields[T]): WizardEventFields[T] {
    const s = this.options.sanitize
    const f = { ...(fields as Record<string, unknown>) }
    switch (type) {
      case "narrate":
        f.text = s(String(f.text ?? ""), EVENT_LIMITS.narrateTextMaxChars)
        break
      case "step.sub":
        f.text = s(String(f.text ?? ""), EVENT_LIMITS.subTextMaxChars)
        break
      case "step.status":
        f.text = s(String(f.text ?? ""), EVENT_LIMITS.statusTextMaxChars)
        break
      case "step.done":
        if (typeof f.reason === "string") f.reason = s(f.reason, REASON_CAP)
        break
      case "job.state":
        if (typeof f.note === "string") f.note = s(f.note, NOTE_CAP)
        break
      case "check.result":
        if (typeof f.reason === "string") f.reason = s(f.reason, REASON_CAP)
        break
      case "ask.open":
        f.payload = sanitizeAskPayload(f.kind as AskKind, f.payload, s)
        break
      default:
        break
    }
    return f as WizardEventFields[T]
  }

  private handleLine(raw: string): void {
    const line = raw.trim()
    if (!line) return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.reject("ignored a stdin line that is not JSON")
      return
    }
    if (shapeErrors(parsed, ASK_ANSWER_LINE_SHAPE).length > 0) {
      this.reject("ignored a stdin line that is not an ask.answer line")
      return
    }
    const answerLine = parsed as AskAnswerLine
    if (answerLine.v !== WIZARD_EVENT_VERSION || answerLine.t !== "ask.answer" || typeof answerLine.askId !== "string") {
      this.reject("ignored a stdin line that is not an ask.answer v1 line")
      return
    }
    const pending = this.store?.getSnapshot().pendingAsk ?? null
    if (!pending || pending.askId !== answerLine.askId) {
      this.reject(`rejected ask.answer for unknown askId ${JSON.stringify(answerLine.askId.slice(0, 80))}`)
      return
    }
    this.store?.answerAsk(answerLine.askId, answerLine.answer)
  }

  private reject(message: string): void {
    this.options.stderr.write(`infinite-tag: ${message}\n`)
  }
}

/** Sanitise the outside-text fields of an ask payload (agent questions, teammate comments). */
export function sanitizeAskPayload(kind: AskKind, payload: unknown, sanitize: UntrustedSanitizer): unknown {
  if (typeof payload !== "object" || payload === null) return payload
  const p = payload as Record<string, unknown>
  if (kind === "agent-questions" && Array.isArray(p.questions)) {
    return {
      ...p,
      questions: p.questions.map((question: Record<string, unknown>) => ({
        ...question,
        question: sanitize(String(question.question ?? ""), 300),
        why: sanitize(String(question.why ?? ""), 300),
        ...(Array.isArray(question.options)
          ? { options: question.options.map((option: Record<string, unknown>) => ({ ...option, label: sanitize(String(option.label ?? ""), 120) })) }
          : {})
      }))
    }
  }
  if (kind === "teammate-comments" && Array.isArray(p.comments)) {
    return {
      ...p,
      comments: p.comments.map((comment: Record<string, unknown>) => ({
        ...comment,
        author: sanitize(String(comment.author ?? ""), 60),
        path: sanitize(String(comment.path ?? ""), 200),
        excerpt: sanitize(String(comment.excerpt ?? ""), 300)
      }))
    }
  }
  return payload
}

export function createJsonUi(options: JsonUiOptions): JsonUi {
  return new JsonUi(options)
}
