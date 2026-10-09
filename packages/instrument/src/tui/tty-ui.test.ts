import { describe, expect, it } from "vitest"

import { FakeStdin, FakeStdout, FakeStore, flushMicrotasks, makeSnapshot, makeTestSanitizer, midRunSnapshot, stepRows } from "../../test/wizard/fake-store.js"
import { SEQ, stripAnsi } from "./ansi.js"
import { TtyUi } from "./tty-ui.js"

function setup(options: { env?: Record<string, string>; columns?: number; store?: FakeStore } = {}) {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout(options.columns ?? 120, 40)
  const interrupts: number[] = []
  const sanitize = makeTestSanitizer()
  const ui = new TtyUi({
    stdin,
    stdout,
    env: options.env ?? {},
    sanitize,
    onInterrupt: () => interrupts.push(1),
    spinnerIntervalMs: 0,
    registerExitHook: false
  })
  const store = options.store ?? new FakeStore(midRunSnapshot())
  return { stdin, stdout, ui, store, interrupts, sanitize }
}

describe("TtyUi lifecycle", () => {
  it("enters the alt screen in raw mode and gives the terminal back on stop, with the exit line in scrollback", () => {
    const { stdin, stdout, ui, store } = setup()
    ui.start(store)
    expect(stdout.text.startsWith(SEQ.enterAltScreen)).toBe(true)
    expect(stdin.rawModes).toEqual([true])
    store.set({ exit: { exitCode: 0, prUrl: "https://github.com/acme/acme-store/pull/42", reportPath: ".infinite/REPORT.md" } })
    ui.stop()
    expect(stdin.rawModes).toEqual([true, false])
    expect(stdin.isRaw).toBe(false)
    const tail = stdout.chunks[stdout.chunks.length - 1] ?? ""
    expect(tail).toContain(SEQ.leaveAltScreen)
    expect(tail).toContain(SEQ.showCursor)
    expect(stripAnsi(tail)).toContain("infinite-tag run r-7f3c: done · PR https://github.com/acme/acme-store/pull/42 · report .infinite/REPORT.md")
    expect(store.listenerCount).toBe(0)
    // Idempotent.
    ui.stop()
    expect(stdin.rawModes).toEqual([true, false])
  })

  it("the exit line's PR URL and report path go through the sanitiser (negative: an escape never reaches scrollback)", () => {
    const { stdout, ui, store, sanitize } = setup()
    ui.start(store)
    store.set({ exit: { exitCode: 0, prUrl: "https://github.com/acme/acme-store/pull/42\x1b]8;;https://evil.example\x07", reportPath: ".infinite/REPORT.md\u202e" } })
    ui.stop()
    const tail = stdout.chunks[stdout.chunks.length - 1] ?? ""
    expect(stripAnsi(tail)).toContain("PR https://github.com/acme/acme-store/pull/42 · report .infinite/REPORT.md")
    expect(tail).not.toContain("evil.example")
    expect(tail).not.toContain("\u202e")
    expect(sanitize.calls.some((text) => text.includes("evil.example"))).toBe(true)
  })

  it("Ctrl+C restores raw mode first, then hands off to the interrupt path", () => {
    const { stdin, ui, store, interrupts } = setup()
    ui.start(store)
    let rawAtInterrupt: boolean | null = null
    ;(ui as unknown as { options: { onInterrupt: () => void } }).options.onInterrupt = () => {
      rawAtInterrupt = stdin.isRaw
      interrupts.push(1)
    }
    stdin.type("\x03")
    expect(interrupts).toHaveLength(1)
    expect(rawAtInterrupt).toBe(false)
    expect(stdin.rawModes).toEqual([true, false])
    // Keys after Ctrl+C are not handled any more.
    stdin.type("\r")
    expect(store.answers).toHaveLength(0)
    ui.stop()
  })
})

describe("TtyUi asks", () => {
  it("answers the pending ask through the store", async () => {
    const store = new FakeStore(
      makeSnapshot({
        currentStep: "keys",
        steps: stepRows({ keys: { state: "running" } }),
        pendingAsk: {
          askId: "ask-1",
          kind: "single",
          payload: {
            question: "The GA4 property has 2 web streams. Which one is this site?",
            options: [
              { label: "www.acme-store.com  (G-FAKE00001)", value: "G-FAKE00001" },
              { label: "acme-store.com  (G-FAKE00002)", value: "G-FAKE00002" }
            ]
          }
        }
      })
    )
    const { stdin, ui } = setup({ store })
    ui.start(store)
    expect(ui.lastFrame().map(stripAnsi).join("\n")).toContain("Which one is this site?")
    stdin.type("\x1b[B")
    stdin.type("\r")
    expect(store.answers).toEqual([{ askId: "ask-1", answer: "G-FAKE00002" }])
    await flushMicrotasks()
    expect(ui.lastFrame().map(stripAnsi).join("\n")).not.toContain("Which one is this site?")
    ui.stop()
  })

  it("tty-handover suspends the UI (raw off, alt screen left) and resumes when the ask closes", async () => {
    const store = new FakeStore(midRunSnapshot())
    const { stdin, stdout, ui } = setup({ store })
    ui.start(store)
    store.set({ pendingAsk: { askId: "h1", kind: "tty-handover", payload: { reason: "gpg", command: "git commit" } } })
    await flushMicrotasks()
    expect(stdin.isRaw).toBe(false)
    expect(stdout.text).toContain(SEQ.leaveAltScreen)
    expect(stdout.text).toContain("handing the terminal to `git commit`")
    const mark = stdout.chunks.length
    store.set({ pendingAsk: null })
    await flushMicrotasks()
    expect(stdin.isRaw).toBe(true)
    expect(stdout.chunks.slice(mark).join("")).toContain(SEQ.enterAltScreen)
    ui.stop()
    expect(stdin.isRaw).toBe(false)
  })
})

