// Final verify F18 / F19: the plan screen, driven through the REAL `TtyUi` (keys on a fake stdin, every frame it
// draws captured) at 64 terminal sizes and along the paths a person takes: ENTER only, edit a line, open and
// cancel the editor, skip a line, and keys arriving in one chunk (a paste). It fails if the plan is approved while
// a line that needs the user was never drawn in full (F18: after leaving the editor, ENTER approved line 6 at 10
// of 64 sizes, 60–81 columns), or if the box jumps at 80 × 24 (F19).
//
// Ported from the round-3 verifier's audit (`ui-artifacts/2026-10-02-infinite-tag-wizard-qa/capture/plan-audit.mts`),
// which modelled `TtyUi` by hand; this drives the class itself.
import { describe, expect, it } from "vitest"

import { FakeStdin, FakeStdout, FakeStore, flushMicrotasks, makeSnapshot, makeTestSanitizer, stepRows } from "../../test/wizard/fake-store.js"
import { ASK_CANCELLED, type AskPayloads, type PlanLine } from "../wizard/contracts/asks.js"
import { stripAnsi } from "./ansi.js"
import { TtyUi } from "./tty-ui.js"

const line = (id: string, kind: PlanLine["kind"], text: string, extra: Partial<PlanLine> = {}): PlanLine => ({ id, kind, text, requires: "approval", editable: false, ...extra })

/** The plan of the recorded round-3 run (16 lines, read off its 120-column capture); line 6 is the one F18 skipped. */
const LINES: PlanLine[] = [
  line("consent_mode", "consent_mode", "Consent: choose — collect by default, or wait for your cookie banner's yes (covers Infinite only)", { editable: true }),
  line("conversion_names", "conversion_names", "Conversions: signup", { editable: true }),
  line("privacy_text", "privacy_text", "Privacy: 2 drafted lines for your privacy page", { editable: true }),
  line("install_provider:infinite", "install_provider", "Install Infinite"),
  line(
    "server_lane",
    "server_lane",
    "Server lane (Next.js middleware): counts every page request on your server, even with ad blockers. After you merge, the one real test visit lands TWO bot-flagged page rows in your Infinite ledger (the visit itself and a server-lane probe). The no-send checks before that land none."
  ),
  line(
    "improve_additive:posthog:proxy",
    "improve_additive",
    "PostHog: send events through your own domain (/ingest) so ad blockers do not drop them. Changes where your existing PostHog sends events, and adds a forwarding rule for /ingest to your site's config."
  ),
  line("improve_additive:posthog:history_change", "improve_additive", "PostHog: count page changes in your single-page app. Changes your existing PostHog setup."),
  line(
    "posthog_defaults_bump_adopted:posthog",
    "posthog_defaults_bump_adopted",
    'PostHog: update your existing setup to PostHog\'s current recommended settings (their 2026-01-30 defaults). This changes how PostHog measures; the report marks it "measurement changed", never growth.'
  ),
  line("sensitive_pages", "sensitive_pages", "PostHog: turn session replay and autocapture off on sensitive pages (/login) in your existing setup."),
  line("preview_guard_adopted:posthog", "preview_guard_adopted", "PostHog: keep preview sites silent. Your existing tag also fires on previews; its start gets the preview check. Production always fires.", {
    measured: { value: "5 of 44 page views were previews", window: "28 days" }
  }),
  line("preview_guard_adopted:ga4", "preview_guard_adopted", "GA4: keep preview sites silent. Your existing tag also fires on previews; its start gets the preview check. Production always fires.", {
    measured: { value: "5 of 44 page views were previews", window: "28 days" }
  }),
  line("remove_duplicate:ga4", "remove_duplicate", "GA4: G-FAKE00001 is set up 2 times in your code, so page views count more than once. Keep one."),
  line("preview_guard_adopted:meta", "preview_guard_adopted", "The site's own Meta pixel fires on preview deployments too"),
  line("meta_relay", "meta_relay", "Meta server events: send your server-side conversions to Meta through Infinite, with ONE shared event id so the browser and server never count twice."),
  line("checkin", "checkin", "Infinite checks your site again 7 days after the deploy and shows you what it finds.", { requires: "info" }),
  line("agent_budget", "agent_budget", "Claude Code: 12 jobs · Opus 4.8 at xhigh effort · up to 30 turns or 10 min · your Claude plan (max) pays")
]
const PAYLOAD: AskPayloads["plan"] = { lines: LINES, decisions: { consentMode: null, conversionNames: ["signup"], privacyText: "one\ntwo", npmInstall: null } }
const NEED_USER = LINES.filter((planLine) => planLine.requires !== "info")

const SIZES: Array<[number, number]> = []
for (const width of [60, 72, 80, 81, 90, 100, 120, 140]) for (const height of [12, 16, 20, 24, 26, 30, 36, 50]) SIZES.push([width, height])

const ENTER = "\r"
const DOWN = "\x1b[B"
const ESC = "\x1b"
/** Each script is typed one chunk per entry, then ENTER until the plan is answered. */
const SCRIPTS: Record<string, string[]> = {
  "ENTER only (after choosing consent)": [ENTER, "e"],
  "edit the conversion names, then ENTER only": [ENTER, "e", DOWN, "e", "x", ENTER],
  "open and cancel the editor (ESC), then ENTER only": [ENTER, "e", DOWN, "e", ESC],
  "skip a line, then ENTER only": [ENTER, "e", DOWN, DOWN, DOWN, " "],
  // A paste: every key in ONE chunk. Each key must still read the screen the previous key produced.
  "edit, then ENTERs pasted in one chunk": [ENTER, "e", DOWN, "e", "x", ENTER + ENTER.repeat(40)]
}

/** The words a person reads off a frame: no styling, no box borders, no cursor mark, no scroll hints. */
function readable(frame: readonly string[]): string {
  return frame
    .map((row) => stripAnsi(row).replace(/[│╭╮╰╯─▸]/g, " ").replace(/↑ this line starts above.*|↓ this line continues.*/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
}
/** A line's words as the plan draws them (the measured value follows the text). */
const words = (planLine: PlanLine) => (planLine.measured ? `${planLine.text} (${planLine.measured.value} · ${planLine.measured.window})` : planLine.text).replace(/\s+/g, " ")

/** Drawn in full: on one frame, or (a line taller than the box) every word of it in order over the frames. */
function drawnInFull(planLine: PlanLine, frames: readonly string[]): boolean {
  if (frames.some((frame) => frame.includes(words(planLine)))) return true
  const want = words(planLine).split(" ")
  let at = 0
  for (const word of frames.join(" ").split(" ")) if (at < want.length && word === want[at]) at += 1
  return at === want.length
}

interface Session {
  frames: string[][]
  answer: unknown
}

async function drive(width: number, height: number, script: readonly string[]): Promise<Session> {
  const stdin = new FakeStdin()
  const stdout = new FakeStdout(width, height)
  const snapshot = makeSnapshot({
    steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "ok" }, keys: { state: "ok" }, plan: { state: "running" } }),
    currentStep: "plan",
    pendingAsk: { askId: "a1", kind: "plan", payload: PAYLOAD }
  })
  const store = new FakeStore(snapshot)
  const ui = new TtyUi({ stdin, stdout, env: {}, sanitize: makeTestSanitizer(), onInterrupt: () => {}, spinnerIntervalMs: 0, registerExitHook: false })
  // Every frame the UI really draws (including one drawn in the middle of a pasted chunk).
  const frames: string[][] = []
  const internals = ui as unknown as { render: () => void }
  const render = internals.render.bind(ui)
  internals.render = () => {
    const before = ui.lastFrame()
    render()
    if (ui.lastFrame() !== before) frames.push([...ui.lastFrame()])
  }
  ui.start(store)
  await flushMicrotasks()
  const typed = [...script]
  for (let presses = 0; store.answers.length === 0 && presses < 80; presses += 1) {
    stdin.type(typed.shift() ?? ENTER)
    await flushMicrotasks()
  }
  ui.stop()
  return { frames, answer: store.answers[0]?.answer }
}

describe("F18: the plan is never approved with a line the user was not shown (the real TtyUi, 64 sizes)", () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(name, { timeout: 60_000 }, async () => {
      const bad: string[] = []
      let approvals = 0
      const cancelled: string[] = []
      for (const [width, height] of SIZES) {
        const session = await drive(width, height, script)
        if (session.answer === undefined) {
          bad.push(`${width}x${height}: never answered`)
          continue
        }
        if (session.answer === ASK_CANCELLED) {
          // In a very short box ↓ reads on inside the tall consent line, so the script's ESC closes the plan instead
          // of an editor: nothing was approved, so nothing can be approved unseen (the audit left these sizes out).
          cancelled.push(`${width}x${height}`)
          continue
        }
        expect(Array.isArray((session.answer as { approved?: unknown }).approved), `${width}x${height}: ${JSON.stringify(session.answer)}`).toBe(true)
        approvals += 1
        const text = session.frames.map(readable)
        const never = NEED_USER.filter((planLine) => !drawnInFull(planLine, text))
        if (never.length > 0) bad.push(`${width}x${height}: approved with ${never.map((planLine) => planLine.id).join(", ")} never drawn in full`)
        // Every frame fits the terminal.
        for (const frame of session.frames) if (frame.length > height) bad.push(`${width}x${height}: a frame of ${frame.length} rows`)
      }
      expect(bad).toEqual([])
      expect(approvals + cancelled.length).toBe(SIZES.length)
      // Only the ESC script may close the plan, and only where ↓ stayed inside the consent line.
      if (!script.includes(ESC)) expect(cancelled).toEqual([])
      for (const size of cancelled) expect(Number(size.split("x")[1]), size).toBeLessThanOrEqual(16)
    })
  }

  it("negative: the check catches a skipped line (a frame list with line 6 removed fails it)", async () => {
    const session = await drive(80, 24, SCRIPTS["ENTER only (after choosing consent)"]!)
    const proxy = LINES.find((planLine) => planLine.id === "improve_additive:posthog:proxy")!
    const text = session.frames.map(readable)
    expect(drawnInFull(proxy, text)).toBe(true)
    expect(drawnInFull(proxy, text.map((frame) => frame.replace("adds a forwarding rule", "")))).toBe(false)
  })
})

describe("F19: at 80 × 24 the plan box holds its height while the plan scrolls", () => {
  for (const [name, script] of Object.entries(SCRIPTS)) {
    it(name, async () => {
      const session = await drive(80, 24, script)
      const plain = session.frames.map((frame) => frame.map((row) => stripAnsi(row)))
      const boxes = plain.map((frame) => ({ top: frame.findIndex((row) => row.includes("╭")), bottom: frame.findIndex((row) => row.includes("╰")) }))
      const drawn = boxes.filter((box) => box.top >= 0)
      expect(drawn.length).toBeGreaterThan(3)
      // One box position and height on every frame (it used to jump by 5 rows as notices came and went)…
      expect(new Set(drawn.map((box) => `${box.top}-${box.bottom}`)).size, JSON.stringify(drawn)).toBe(1)
      // …and the step list never comes back above it.
      for (const frame of plain) expect(frame.some((row) => row.trim() === "Tasks")).toBe(false)
    })
  }
})
