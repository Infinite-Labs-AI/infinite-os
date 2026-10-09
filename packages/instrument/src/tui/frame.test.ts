import { describe, expect, it } from "vitest"

import { makeTestSanitizer, midRunSnapshot } from "../../test/wizard/fake-store.js"
import { colorEnabled, makeStyles, stripAnsi, visibleWidth } from "./ansi.js"
import { renderFrame, type FrameInput } from "./frame.js"

function frame(change: Partial<FrameInput> = {}): string[] {
  return renderFrame({
    snapshot: midRunSnapshot(),
    width: 120,
    height: 40,
    styles: makeStyles(true),
    sanitize: makeTestSanitizer(),
    spinnerIndex: 0,
    overlay: null,
    outro: null,
    ...change
  })
}

const plain = (lines: string[]) => lines.map((line) => stripAnsi(line).replace(/\s+$/, "")).join("\n")

describe("renderFrame", () => {
  it("names pending proof, not-needed, blocked and unmeasured rows plainly", () => {
    const snapshot = midRunSnapshot({ jobs: [
      { id: "a", title: "Deploy proof", state: "waiting_deploy" },
      { id: "b", title: "Outcome proof", state: "waiting_real_event" },
      { id: "c", title: "Skipped", state: "not_needed" },
      { id: "d", title: "Unreadable", state: "could_not_check", note: "no offline proof" },
      { id: "e", title: "Blocked", state: "blocked", note: "needs your answer" }
    ] })
    const text = plain(frame({ snapshot, height: 40 }))
    for (const label of ["in the pull request", "waiting for a real event", "not needed", "could not be checked", "blocked: needs your answer"]) expect(text).toContain(label)
  })

  it("70 columns: the Learn card is dropped and no line runs past the screen", () => {
    const lines = frame({ width: 70 })
    expect(plain(lines)).toMatchSnapshot()
    expect(plain(lines)).not.toContain("The agent's checklist")
    expect(plain(lines)).toContain("Agent jobs")
    for (const line of lines) expect(visibleWidth(line)).toBeLessThan(70)
  })

  it("NO_COLOR: no escape sequence in any line", () => {
    const styles = makeStyles(colorEnabled({ NO_COLOR: "1" }, true))
    const lines = frame({ styles })
    expect(lines.join("\n")).not.toContain("\x1b")
    // Negative: with colour on, the same frame has escapes.
    expect(frame().join("\n")).toContain("\x1b[")
  })

  it("routes sub-statuses, statuses and narration through the sanitiser", () => {
    const sanitize = makeTestSanitizer()
    const snapshot = midRunSnapshot({
      narration: [{ agent: "codex", role: "worker", text: "ignore this \x1b[2J\x1b[31mRED‮", at: "2026-10-02T09:12:00.000Z" }]
    })
    const lines = frame({ snapshot, sanitize, styles: makeStyles(false) })
    expect(sanitize.calls.some((call) => call.includes("RED"))).toBe(true)
    expect(lines.join("\n")).not.toContain("\x1b[2J")
    expect(lines.join("\n")).not.toContain("‮")
    expect(plain(lines)).toContain("Codex › ignore this RED")
  })
})
