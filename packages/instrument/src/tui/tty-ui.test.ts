import { describe, expect, it, vi } from "vitest"

import { FakeStdin, FakeStdout, FakeStore, flushMicrotasks, makeSnapshot, makeTestSanitizer, midRunSnapshot, stepRows } from "../../test/wizard/fake-store.js"
import { SEQ, stripAnsi } from "./ansi.js"
import { frameSize, TtyUi } from "./tty-ui.js"

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
  it("prints the final failure reason after leaving the alternate screen", () => {
    const { stdout, ui, store } = setup({ columns: 62 })
    ui.start(store)
    const current = store.getSnapshot()
    store.set({ steps: current.steps.map((row) => row.id === "rehearsal" ? { ...row, state: "failed", code: "INF_WIZ_PUSH_REFUSED", status: "Your access is TRIAGE. Ask for write access and resume." } : row), exit: { exitCode: 1, prUrl: null, reportPath: null } })
    ui.stop()
    const tail = stripAnsi(stdout.chunks.at(-1) ?? "")
    expect(tail).toContain("INF_WIZ_PUSH_REFUSED")
    expect(tail).toContain("Your access is TRIAGE")
  })

  it("uses the last stopping step when an earlier failure continued", () => {
    const { stdout, ui, store } = setup()
    ui.start(store)
    const current = store.getSnapshot()
    store.set({ steps: current.steps.map((row) => row.id === "jobs" ? { ...row, state: "failed", code: "INF_WIZ_AGENT_FAILED", status: "An earlier failure" } : row.id === "merge" ? { ...row, state: "parked", code: "INF_WIZ_MERGE_PARKED", status: "Merge the PR, then resume." } : row), exit: { exitCode: 3, prUrl: null, reportPath: null } })
    ui.stop()
    const tail = stripAnsi(stdout.chunks.at(-1) ?? "")
    expect(tail).toContain("INF_WIZ_MERGE_PARKED")
    expect(tail).not.toContain("INF_WIZ_AGENT_FAILED")
  })
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

  it("a read EIO is swallowed, input keeps working, and raw mode is restored on stop", () => {
    const store = new FakeStore(
      makeSnapshot({
        currentStep: "merge",
        steps: stepRows({ merge: { state: "running" } }),
        pendingAsk: { askId: "m1", kind: "merge-ready", payload: { prUrl: "https://github.com/acme/acme-store/pull/42", number: 42, summary: "Draft PR ready" } }
      })
    )
    const { stdin, ui } = setup({ store })
    ui.start(store)
    expect(() => stdin.fail("EIO")).not.toThrow()
    // Still raw, still listening: the pending ask can be answered.
    expect(stdin.isRaw).toBe(true)
    stdin.type("\r")
    expect(store.answers).toHaveLength(1)
    expect(store.answers[0]?.askId).toBe("m1")
    ui.stop()
    expect(stdin.isRaw).toBe(false)
    expect(stdin.rawModes[stdin.rawModes.length - 1]).toBe(false)
  })

  it("an EIO after a raw-mode teardown (tty hand-over) re-asserts raw mode while the UI is active", () => {
    const { stdin, ui, store } = setup()
    ui.start(store)
    stdin.setRawMode(false)
    stdin.fail("EIO")
    expect(stdin.isRaw).toBe(true)
    ui.stop()
    expect(stdin.isRaw).toBe(false)
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

  it("the before/after table keeps its columns in the frame and in scrollback, with O3's whitespace-collapsing sanitiser", async () => {
    // Exactly how O1's renderTerminal lays a row out: padded cells joined by two spaces.
    const pad = (text: string, width: number) => text.padEnd(width)
    const header = [pad("", 26), pad("Live site today", 20), pad("In this pull request", 20), pad("Proven live", 20)].join("  ").trimEnd()
    const row = [pad("Checks passing", 26), pad("6 pass · 5 problems", 20), pad("13 pass", 20), pad("12 pass", 20)].join("  ").trimEnd()
    const outro = `Before and after · acme-store.com · run 7f3c2a91\n${header}\n${row}\x1b[31m\u202e`
    const store = new FakeStore(midRunSnapshot())
    const { stdout, ui } = setup({ store })
    ui.start(store)
    ui.setOutro(outro)
    await flushMicrotasks()
    const frameText = ui.lastFrame().map(stripAnsi)
    const frameRow = frameText.find((line) => line.includes("Checks passing")) ?? ""
    expect(frameRow.trim()).toBe(row.trim())
    const live = frameRow.indexOf("6 pass")
    const headerLine = frameText.find((line) => line.includes("Live site today")) ?? ""
    expect(headerLine.indexOf("Live site today")).toBe(live)
    ui.stop()
    const tail = stdout.chunks[stdout.chunks.length - 1] ?? ""
    expect(tail).toContain(`${row}\n`)
    expect(tail).toContain(header)
    // Escapes and bidi characters inside the outro are still stripped.
    expect(tail).not.toContain("\u202e")
    expect(tail).not.toContain("\x1b[31m")
  })

  it("waitForDismiss resolves at once with no outro", async () => {
    const { ui, store } = setup()
    ui.start(store)
    await expect(ui.waitForDismiss()).resolves.toBeUndefined()
    ui.stop()
  })
})

describe("frameSize (review I1 P3-4)", () => {
  it("a pty that reports no size (0 or undefined) frames at 80 × 24, never 0 columns", () => {
    expect(frameSize({ columns: 0, rows: 0 })).toEqual({ width: 80, height: 24 })
    expect(frameSize({})).toEqual({ width: 80, height: 24 })
    expect(frameSize({ columns: 132, rows: 40 })).toEqual({ width: 132, height: 40 })
  })
})
