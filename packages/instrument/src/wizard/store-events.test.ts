import { describe, expect, it } from "vitest"

import { ASK_CANCELLED } from "./contracts/asks.js"
import { EVENT_LIMITS, WIZARD_EVENT_SHAPES, wizardEventLineShape, type WizardEvent } from "./contracts/events.js"
import { shapeErrors } from "./contracts/shape.js"
import { cleanEventText, WizardEventEmitter, type EmitterTimers } from "./events.js"
import { StoreAskConflictError, WizardStore } from "./store.js"

function fakeTimers() {
  let now = Date.parse("2026-10-02T09:00:00Z")
  const pending: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const timers: EmitterTimers = {
    set: (fn, ms) => {
      const id = nextId++
      pending.push({ at: now + ms, fn, id })
      return id
    },
    clear: (handle) => {
      const index = pending.findIndex((timer) => timer.id === handle)
      if (index >= 0) pending.splice(index, 1)
    }
  }
  return {
    timers,
    now: () => new Date(now),
    advance(ms: number) {
      const target = now + ms
      for (;;) {
        pending.sort((a, b) => a.at - b.at)
        const next = pending[0]
        if (!next || next.at > target) break
        pending.shift()
        now = next.at
        next.fn()
      }
      now = target
    }
  }
}

function setup(json = false) {
  const clock = fakeTimers()
  const store = new WizardStore({ displayId: "r-7f3c", tagVersion: "0.12.0", now: clock.now })
  const lines: string[] = []
  const events: WizardEvent[] = []
  const emitter = new WizardEventEmitter({ store, ndjson: json ? (line) => lines.push(line) : null, now: clock.now, timers: clock.timers, onEvent: (event) => events.push(event) })
  return { clock, store, emitter, lines, events }
}

describe("WizardStore", () => {
  it("keeps resumed and checked job rows in their actual states", () => {
    const { store, emitter } = setup()
    store.stepStart("jobs")
    store.jobSeeded({ id: "a", title: "A", state: "waiting_deploy" })
    expect(store.getSnapshot().jobs?.[0]?.state).toBe("waiting_deploy")
    emitter.emit("job.state", { itemId: "a", state: "waiting_real_event", by: "wizard" })
    expect(store.getSnapshot().jobs?.[0]?.state).toBe("waiting_real_event")
    emitter.emit("job.state", { itemId: "a", state: "not_needed", by: "wizard" })
    expect(store.getSnapshot().jobs?.[0]?.state).toBe("not_needed")
    emitter.emit("job.state", { itemId: "a", state: "claimed", by: "wizard", note: "no check could decide" })
    expect(store.getSnapshot().jobs?.[0]).toMatchObject({ state: "could_not_check", note: "no check could decide" })
    emitter.emit("job.progress", { itemId: "a", state: "agent_blocked" })
    expect(store.getSnapshot().jobs?.[0]?.state).toBe("agent_blocked")
    store.stepStart("jobs")
    store.jobSeeded({ id: "a", title: "A", state: "proven" })
    expect(store.getSnapshot().jobs?.[0]?.state).toBe("proven")
  })
  it("retains the job progress high-water count when a provisional failure is reclaimed", () => {
    const { store } = setup()
    for (const id of ["a", "b", "c"]) store.jobSeeded({ id, title: id, state: "pending" })
    store.jobDisplay("a", "failed")
    store.jobDisplay("b", "done_in_code")
    expect(store.getSnapshot().jobsSettledHighWater).toBe(2)
    store.jobDisplay("a", "checking")
    expect(store.getSnapshot().jobsSettledHighWater).toBe(2)
  })
  it("retains the stopping reason over a stale running status", () => {
    const { store } = setup()
    store.stepStart("rehearsal")
    store.stepStatus("rehearsal", "Pushing the branch…")
    store.stepDone("rehearsal", "failed", "INF_WIZ_PUSH_REFUSED", "Your GitHub access cannot push this branch.")
    expect(store.getSnapshot().steps.find((row) => row.id === "rehearsal")?.status).toBe("Your GitHub access cannot push this branch.")
  })
  it("keeps each job in one row while its live state changes", () => {
    const { store, emitter } = setup()
    store.jobSeeded({ id: "a", title: "First job", state: "pending" })
    store.jobSeeded({ id: "b", title: "Second job", state: "pending" })
    emitter.emit("job.progress", { itemId: "a", state: "agent_claim" })
    expect(store.getSnapshot().jobs).toEqual([
      { id: "a", title: "First job", state: "agent_claim" },
      { id: "b", title: "Second job", state: "waiting" }
    ])
    emitter.emit("job.state", { itemId: "a", state: "done_in_code", by: "wizard" })
    expect(store.getSnapshot().jobs?.[0]?.state).toBe("done_in_code")
  })
  it("bumps the version and tells subscribers on every change; snapshots are new objects", () => {
    const { store } = setup()
    const seen: number[] = []
    const off = store.subscribe(() => seen.push(store.version))
    const before = store.getSnapshot()
    store.stepStart("link")
    store.stepStatus("link", "Waiting for approval")
    expect(seen).toEqual([1, 2])
    expect(store.getSnapshot()).not.toBe(before)
    expect(before.currentStep).toBeNull()
    expect(store.getSnapshot()).toMatchObject({ currentStep: "link", learn: "link" })
    off()
    store.stepDone("link", "ok", null, null)
    expect(seen).toEqual([1, 2])
  })

  it("holds at most ONE pending ask: a second throws (negative), an answer closes it, an unknown id changes nothing", async () => {
    const { store } = setup()
    const first = store.openAsk("confirm", { question: "Start fresh?", defaultYes: false }, "ask_1")
    expect(() => store.openAsk("single", { question: "Which stream?", options: [] })).toThrow(StoreAskConflictError)
    expect(store.answerAsk("ask_nope", true)).toBe(false)
    expect(store.getSnapshot().pendingAsk?.askId).toBe("ask_1")
    expect(store.answerAsk("ask_1", true)).toBe(true)
    await expect(first.answer).resolves.toBe(true)
    expect(store.getSnapshot().pendingAsk).toBeNull()
    const second = store.openAsk("single", { question: "Which stream?", options: [] }, "ask_2")
    store.cancelAsk()
    await expect(second.answer).resolves.toBe(ASK_CANCELLED)
  })

  it("gates latch once and stay open", async () => {
    const { store } = setup()
    let opened = 0
    void store.gate("intro").then(() => (opened += 1))
    expect(store.isGateOpen("intro")).toBe(false)
    store.openGate("intro")
    store.openGate("intro")
    await store.gate("intro")
    await Promise.resolve()
    expect(opened).toBe(1)
    expect(store.isGateOpen("intro")).toBe(true)
  })
})

describe("WizardEventEmitter: the sub-status throttle (≤1 per 3 s per step, ≤8 kept)", () => {
  it("releases the first sub at once, then at most one per 3 s; progress subs coalesce to the newest", () => {
    const { clock, emitter, events } = setup()
    const subs = () => events.filter((event) => event.t === "step.sub").map((event) => (event as { text: string }).text)
    emitter.emit("step.sub", { step: "prove", text: "Waiting for the deploy…", tone: "pending" })
    emitter.emit("step.sub", { step: "prove", text: "still waiting 1", tone: "pending" })
    emitter.emit("step.sub", { step: "prove", text: "still waiting 2", tone: "pending" })
    expect(subs()).toEqual(["Waiting for the deploy…"])
    clock.advance(EVENT_LIMITS.subThrottleMs - 1)
    expect(subs()).toHaveLength(1)
    clock.advance(1)
    expect(subs()).toEqual(["Waiting for the deploy…", "still waiting 2"])
  })

  it("never drops a result sub: ok/warn queue one per window, and step.done flushes them at once", () => {
    const { clock, emitter, events, store } = setup()
    const subs = () => events.filter((event) => event.t === "step.sub").map((event) => (event as { text: string }).text)
    emitter.emit("step.sub", { step: "prove", text: "One real visit…", tone: "pending" })
    emitter.emit("step.sub", { step: "prove", text: "✓ Infinite pixel", tone: "ok" })
    emitter.emit("step.sub", { step: "prove", text: "✓ PostHog", tone: "ok" })
    emitter.emit("step.sub", { step: "prove", text: "· GA4", tone: "warn" })
    clock.advance(3_000)
    expect(subs()).toEqual(["One real visit…", "✓ Infinite pixel"])
    emitter.emit("step.done", { step: "prove", outcome: "ok" })
    expect(subs()).toEqual(["One real visit…", "✓ Infinite pixel", "✓ PostHog", "· GA4"])
    const doneIndex = events.findIndex((event) => event.t === "step.done")
    expect(doneIndex).toBeGreaterThan(events.findIndex((event) => (event as { text?: string }).text === "· GA4"))
    expect(store.getSnapshot().steps.find((row) => row.id === "prove")?.subs.map((sub) => sub.text)).toEqual(subs())
  })

  it("keeps at most 8 subs per step in the store", () => {
    const { clock, emitter, store } = setup()
    for (let index = 0; index < 12; index += 1) {
      emitter.emit("step.sub", { step: "jobs", text: `Job ${index}`, tone: "ok" })
      clock.advance(3_000)
    }
    const kept = store.getSnapshot().steps.find((row) => row.id === "jobs")!.subs
    expect(kept).toHaveLength(EVENT_LIMITS.subKeptPerStep)
    expect(kept.at(-1)!.text).toBe("Job 11")
  })

  it("strips terminal escapes, control and bidi characters and caps text (negative: a raw escape never reaches stdout)", () => {
    const { emitter, lines } = setup(true)
    emitter.emit("narrate", { agent: "claude_code", role: "worker", text: `Editing \u001b[31mapp/layout.tsx\u001b[0m\u202e now\u0007${"x".repeat(300)}` })
    const line = JSON.parse(lines[0]!) as { text: string }
    expect(line.text).not.toMatch(/[\u001b\u0007\u202e]/)
    expect(line.text.startsWith("Editing app/layout.tsx now")).toBe(true)
    expect(line.text.length).toBe(EVENT_LIMITS.narrateTextMaxChars)
    expect(cleanEventText("a\nb\tc", 10)).toBe("a b c")
  })

  it("writes one NDJSON line per event, each with v, t and at plus exactly the §3d.2 fields", () => {
    const { emitter, lines } = setup(true)
    emitter.emit("run.start", { runId: null, displayId: "r-7f3c", tagVersion: "0.12.0", root: "/repo", appRoot: "." })
    emitter.emit("step.start", { step: "link" })
    emitter.emit("step.status", { step: "link", text: "Approved" })
    emitter.emit("step.done", { step: "link", outcome: "ok" })
    emitter.emit("run.end", { exitCode: 0, runId: null, reportPath: null })
    expect(lines).toHaveLength(5)
    for (const text of lines) {
      const event = JSON.parse(text) as WizardEvent
      expect(event.v).toBe(1)
      expect(typeof event.at).toBe("string")
      expect(shapeErrors(event, wizardEventLineShape(event.t))).toEqual([])
    }
    const bad = { ...JSON.parse(lines[1]!), extra: 1 }
    expect(shapeErrors(bad, wizardEventLineShape("step.start")).length).toBeGreaterThan(0)
    expect(Object.keys(WIZARD_EVENT_SHAPES)).toContain("run.end")
  })
})

it("every exclusion result is released immediately, even beyond the progress queue limit", () => {
  const { emitter, events } = setup()
  emitter.emit("step.sub", { step: "plan", text: "Writing plan", tone: "pending" })
  for (let i = 0; i < 24; i++) emitter.emit("step.sub", { step: "plan", text: `You said no to: action:${i}`, tone: "result" })
  expect(events.filter(event => event.t === "step.sub" && event.tone === "result")).toHaveLength(24)
  emitter.dispose()
})
