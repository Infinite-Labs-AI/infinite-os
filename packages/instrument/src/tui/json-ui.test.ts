import { EventEmitter } from "node:events"

import { describe, expect, it } from "vitest"

import { FakeStore, makeSnapshot, makeTestSanitizer } from "../../test/wizard/fake-store.js"
import { WIZARD_EVENT_SHAPES, wizardEventLineShape } from "../wizard/contracts/events.js"
import { shapeErrors } from "../wizard/contracts/shape.js"
import { JsonUi } from "./json-ui.js"

class Lines {
  readonly chunks: string[] = []
  write(chunk: string): boolean {
    this.chunks.push(chunk)
    return true
  }
  get lines(): string[] {
    return this.chunks.join("").split("\n").filter(Boolean)
  }
}

class Input extends EventEmitter {
  setEncoding(): this {
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
}

function setup(store = new FakeStore()) {
  const stdin = new Input()
  const stdout = new Lines()
  const stderr = new Lines()
  const sanitize = makeTestSanitizer()
  const ui = new JsonUi({ stdin, stdout, stderr, sanitize, now: () => new Date("2026-10-02T09:00:00.000Z") })
  ui.start(store)
  return { stdin, stdout, stderr, ui, store, sanitize }
}

describe("JsonUi", () => {
  it("writes one NDJSON line per event, each a valid v1 event line", () => {
    const { ui, stdout } = setup()
    ui.emit("run.start", { runId: null, displayId: "r-7f3c", tagVersion: "0.12.0", root: "/r", appRoot: "." })
    ui.emit("step.start", { step: "link" })
    ui.emit("step.sub", { step: "link", text: "Waiting for approval in the Infinite app…", tone: "pending" })
    ui.emit("step.done", { step: "link", outcome: "ok" })
    expect(stdout.lines).toHaveLength(4)
    for (const line of stdout.lines) {
      const event = JSON.parse(line) as { t: keyof typeof WIZARD_EVENT_SHAPES; v: number; at: string }
      expect(event.v).toBe(1)
      expect(event.at).toBe("2026-10-02T09:00:00.000Z")
      expect(shapeErrors(event, wizardEventLineShape(event.t))).toEqual([])
    }
  })

  it("refuses an event that breaks its shape (negative)", () => {
    const { ui, stdout } = setup()
    expect(() => ui.emit("step.start", { step: "link", extra: 1 } as never)).toThrow(/does not match/)
    expect(stdout.lines).toHaveLength(0)
  })

  it("sanitises narration, sub-statuses and agent questions before writing", () => {
    const { ui, stdout, sanitize } = setup()
    ui.emit("narrate", { agent: "codex", role: "worker", text: "ok \x1b[2J‮wipe" })
    ui.emit("ask.open", {
      askId: "q1",
      kind: "agent-questions",
      payload: { questions: [{ itemId: "job8", question: "Which? \x1b[31m", why: "because\u0007" }] }
    })
    const text = stdout.chunks.join("")
    expect(text).not.toContain("\\u001b[2J")
    expect(text).not.toContain("\\u202e")
    expect(text).not.toContain("\\u0007")
    expect(sanitize.calls.some((call) => call.includes("wipe"))).toBe(true)
    expect(sanitize.calls.some((call) => call.includes("Which?"))).toBe(true)
  })

  it("rejects an unknown askId on stderr and never touches the store (negative)", () => {
    const store = new FakeStore(makeSnapshot({ pendingAsk: { askId: "ask-1", kind: "confirm", payload: { question: "?", defaultYes: true } } }))
    const { stdin, stderr, stdout } = setup(store)
    stdin.emit("data", '{"v":1,"t":"ask.answer","askId":"ask-9","answer":true}\n')
    expect(store.answers).toHaveLength(0)
    expect(stderr.lines[0]).toMatch(/unknown askId "ask-9"/)
    expect(stdout.lines).toHaveLength(0)
  })
})
