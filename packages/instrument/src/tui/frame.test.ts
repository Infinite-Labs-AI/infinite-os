import { describe, expect, it } from "vitest"

import { makeSnapshot, makeTestSanitizer, midRunSnapshot, stepRows } from "../../test/wizard/fake-store.js"
import { colorEnabled, makeStyles, stripAnsi, visibleWidth } from "./ansi.js"
import { renderFrame, type FrameInput } from "./frame.js"
import { OVERLAYS } from "./overlays/index.js"
import type { OverlayContext } from "./overlays/types.js"
import { hostRefusalLine } from "../wizard/site-host.js"

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
  it("shows every job as a stable checklist and moves the bar during a long running step", () => {
    const base = midRunSnapshot()
    const snapshot = midRunSnapshot({
      currentStep: "jobs",
      steps: base.steps.map((row) => row.id === "jobs" ? { ...row, startedAt: "2026-10-02T09:00:00.000Z", status: "Writing the changes · 3 files edited" } : row),
      jobs: [
        { id: "a", title: "Add capture", state: "passed" },
        { id: "b", title: "Guard Meta", state: "checking" },
        { id: "c", title: "Update privacy", state: "waiting" }
      ]
    })
    const text = plain(frame({ snapshot, nowMs: Date.parse("2026-10-02T09:08:00.000Z") }))
    for (const title of ["Add capture", "Guard Meta", "Update privacy"]) expect(text).toContain(title)
    expect(text).toContain("Writing the changes")
    expect(text).toMatch(/\b4[7-9]%|\b5[0-3]%/)
  })
  it("120 columns: Learn card beside the 13-row step list, the narration and the sub-statuses", () => {
    const lines = frame()
    expect(plain(lines)).toMatchSnapshot()
    const text = plain(lines)
    expect(text).toContain("The agent's checklist")
    expect(text).toContain("Claude Code › The sign-up route")
    // A 40-row terminal has the room for every sub-status the store keeps (6 were emitted, 8 are kept).
    expect(text).toContain("Job 1/7")
    // A 24-row one keeps the last 5 only.
    const short = plain(frame({ height: 24 }))
    expect(short).not.toContain("Job 1/7")
    expect(short).toContain("Job 2/7")
    for (const line of lines) expect(visibleWidth(line)).toBeLessThan(120)
  })

  it("R2-3: a long sub-status (the refused-host reason) wraps in full; it is never cut at 120 characters", () => {
    const at = "2026-10-03T08:28:40.000Z"
    const reason = hostRefusalLine({ reason: "preview", shown: "example-shop-site-mix177n53-example-team.vercel.app" })
    expect(reason.length).toBeGreaterThan(120)
    const snapshot = midRunSnapshot({ currentStep: "before", steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "running", subs: [{ text: reason, tone: "warn", at }] } }) })
    for (const width of [80, 120]) {
      const text = plain(frame({ snapshot, width })).replace(/\s+/g, " ")
      expect(text, `width ${width}`).toContain("Or type your own domain now (ESC if it has none yet).")
      expect(text).not.toContain("collects o …")
      for (const line of frame({ snapshot, width })) expect(visibleWidth(line)).toBeLessThan(width)
    }
  })

  it("70 columns: the Learn card is dropped and no line runs past the screen", () => {
    const lines = frame({ width: 70 })
    expect(plain(lines)).toMatchSnapshot()
    expect(plain(lines)).not.toContain("The agent's checklist")
    expect(plain(lines)).toContain("Agent jobs")
    for (const line of lines) expect(visibleWidth(line)).toBeLessThan(70)
  })

  it("80 columns is the threshold for the Learn card (negative: 79 drops it)", () => {
    expect(plain(frame({ width: 80 }))).toContain("The agent's checklist")
    expect(plain(frame({ width: 79 }))).not.toContain("The agent's checklist")
  })

  it("NO_COLOR: no escape sequence in any line", () => {
    const styles = makeStyles(colorEnabled({ NO_COLOR: "1" }, true))
    const lines = frame({ styles })
    expect(lines.join("\n")).not.toContain("\x1b")
    // Negative: with colour on, the same frame has escapes.
    expect(frame().join("\n")).toContain("\x1b[")
  })

  it("prints the runtime variant in the header when it is not prod", () => {
    const dev = plain(frame({ snapshot: midRunSnapshot({ run: { runId: null, displayId: "r-7f3c", tagVersion: "0.12.0", runtimeVariant: "dev3" } }) }))
    expect(dev.split("\n")[0]).toContain("Infinite dev3")
    expect(plain(frame()).split("\n")[0]).not.toContain("Infinite prod")
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

  it("marks parked, blocked and failed steps with their status", () => {
    const snapshot = makeSnapshot({
      steps: stepRows({ link: { state: "blocked", status: "Open the Infinite app (and sign in)", code: "INF_WIZ_NO_APP" } }),
      currentStep: null
    })
    const text = plain(frame({ snapshot }))
    expect(text).toContain("! Link to Infinite · Open the Infinite app")
  })

  it("draws the pending ask as one overlay box in place of the live region", () => {
    const sanitize = makeTestSanitizer()
    const payload = {
      lines: [
        { id: "install_provider:infinite", kind: "install_provider" as const, text: "Install the Infinite pixel and server lane", requires: "approval" as const, editable: false },
        { id: "consent_mode", kind: "consent_mode" as const, text: "Consent setting", requires: "approval" as const, editable: true },
        { id: "user_action:connect_ga4", kind: "user_action" as const, text: "Connect GA4 in Infinite", requires: "user_action" as const, editable: false }
      ],
      decisions: { consentMode: null, conversionNames: ["start_trial", "signup"], privacyText: "line one\nline two", npmInstall: "npm install @vercel/functions" }
    }
    const state = OVERLAYS.plan.init(payload)
    const overlay = (ctx: OverlayContext) => OVERLAYS.plan.render(payload, state, ctx)
    const snapshot = makeSnapshot({
      steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "ok" }, keys: { state: "ok" }, plan: { state: "running" } }),
      currentStep: "plan",
      pendingAsk: { askId: "a1", kind: "plan", payload }
    })
    const lines = frame({ snapshot, overlay, sanitize })
    expect(plain(lines)).toMatchSnapshot()
    const text = plain(lines)
    expect(text).toContain("The plan (one screen)")
    expect(text).toContain("[✓] Install the Infinite pixel")
    expect(text).toContain("ENTER approve")
    expect(lines.length).toBeLessThanOrEqual(40)
  })

  it("shows the outro instead of the step screen", () => {
    const outro = "◆ acme-store collects analytics properly now · run r-7f3c\nChecks passing   6 pass · 5 problems · 3 unknown   13 pass"
    const text = plain(frame({ outro }))
    expect(text).toContain("collects analytics properly now")
    expect(text).not.toContain("Tasks")
  })

  it("a short terminal keeps the steps around the current one", () => {
    const lines = frame({ height: 16 })
    expect(lines.length).toBeLessThanOrEqual(16)
    expect(plain(lines)).toContain("Agent jobs")
  })

  it("a very short terminal keeps the whole question box (its keys line) and drops steps first", () => {
    const payload = { question: "The GA4 property has 2 web streams. Which one is this site?", options: [{ label: "a", value: "a" }, { label: "b", value: "b" }] }
    const state = OVERLAYS.single.init(payload)
    const snapshot = makeSnapshot({ currentStep: "keys", steps: stepRows({ keys: { state: "running" } }), pendingAsk: { askId: "a", kind: "single", payload } })
    for (const height of [12, 14, 18]) {
      const lines = frame({ snapshot, height, overlay: (ctx) => OVERLAYS.single.render(payload, state, ctx) })
      expect(lines.length).toBeLessThanOrEqual(height)
      expect(plain(lines)).toContain("ENTER choose")
      expect(plain(lines)).toContain("╰")
    }
  })
})
