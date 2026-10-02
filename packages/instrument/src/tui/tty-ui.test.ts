import { describe, expect, it, vi } from "vitest"

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

  it("restores the raw mode it found (a terminal already in raw mode stays raw)", () => {
    const { stdin, ui, store } = setup()
    stdin.isRaw = true
    ui.start(store)
    ui.stop()
    expect(stdin.rawModes).toEqual([true, true])
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

  it("a read EIO is swallowed and raw mode is restored", () => {
    const { stdin, ui, store } = setup()
    ui.start(store)
    expect(() => stdin.fail("EIO")).not.toThrow()
    expect(stdin.rawModes).toEqual([true, false])
    ui.stop()
  })

  it("any other stdin error still surfaces (negative)", () => {
    const { stdin, ui, store } = setup()
    ui.start(store)
    expect(() => stdin.fail("EBADF")).toThrow(/EBADF/)
    expect(stdin.isRaw).toBe(false)
    ui.stop()
  })

  it("redraws only the lines that changed", async () => {
    const { stdout, ui, store } = setup()
    ui.start(store)
    const before = stdout.chunks.length
    const steps = store.snapshot.steps.map((row) =>
      row.id === "jobs" ? { ...row, subs: [...row.subs, { text: "Job 4/7 · Join logged-in visitors", tone: "info" as const, at: "t" }] } : row
    )
    store.set({ steps })
    await flushMicrotasks()
    const redraw = stdout.chunks.slice(before).join("")
    expect(redraw).not.toContain(SEQ.clearScreen)
    expect(stripAnsi(redraw)).toContain("Job 4/7")
    expect(stripAnsi(redraw)).not.toContain("Link to Infinite")
    ui.stop()
  })

  it("NO_COLOR: frames carry cursor control only, no colour", () => {
    const { stdout, ui, store } = setup({ env: { NO_COLOR: "1" } })
    ui.start(store)
    const frame = ui.lastFrame().join("\n")
    expect(frame).not.toContain("\x1b")
    ui.stop()
    expect(stdout.text).not.toMatch(/\x1b\[3[0-9]m/)
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

  it("link-code: ESC cancels", () => {
    const store = new FakeStore(
      makeSnapshot({
        currentStep: "link",
        steps: stepRows({ link: { state: "running" } }),
        pendingAsk: { askId: "ask-2", kind: "link-code", payload: { code: "4729", site: { repoLabel: "github.com/acme/acme-store", appRoot: "apps/web", folderLabel: "~/Github/acme-store" } } }
      })
    )
    const { stdin, ui } = setup({ store })
    ui.start(store)
    const text = ui.lastFrame().map(stripAnsi).join("\n")
    expect(text).toContain("4 7 2 9")
    expect(text).toContain("~/Github/acme-store (app: apps/web)")
    stdin.type("\x1b")
    expect(store.answers).toEqual([{ askId: "ask-2", answer: "__cancelled__" }])
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

  it("the outro waits for ENTER / Q, then leaves the outro in scrollback", async () => {
    const store = new FakeStore(midRunSnapshot())
    const { stdin, stdout, ui } = setup({ store })
    ui.start(store)
    ui.setOutro("◆ acme-store collects analytics properly now · run r-7f3c\nChecks passing   6 pass   13 pass")
    await flushMicrotasks()
    expect(ui.lastFrame().map(stripAnsi).join("\n")).toContain("collects analytics properly now")
    const dismissed = vi.fn()
    void ui.waitForDismiss().then(dismissed)
    await flushMicrotasks()
    expect(dismissed).not.toHaveBeenCalled()
    stdin.type("q")
    await flushMicrotasks()
    expect(dismissed).toHaveBeenCalled()
    ui.stop()
    expect(stdout.chunks[stdout.chunks.length - 1]).toContain("collects analytics properly now")
  })

  it("waitForDismiss resolves at once with no outro", async () => {
    const { ui, store } = setup()
    ui.start(store)
    await expect(ui.waitForDismiss()).resolves.toBeUndefined()
    ui.stop()
  })
})
