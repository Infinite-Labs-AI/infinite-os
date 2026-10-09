import { isRepositoryWork } from "../install/plan-permission.js"
// The terminal round (final verify F1, F3, F5 and the terminal QA's display items): what a customer SEES.
// Every test here fails on the code before the round (each was checked against the old source).
import { describe, expect, it } from "vitest"

import { makeSnapshot, makeTestSanitizer, midRunSnapshot, stepRows } from "../../test/wizard/fake-store.js"
import type { AskPayloads, PlanLine } from "../wizard/contracts/asks.js"
import { makeStyles, stripAnsi, visibleWidth } from "./ansi.js"
import { overlayContext, renderFrame, type FrameInput } from "./frame.js"
import { OVERLAYS } from "./overlays/index.js"
import type { PlanState } from "./overlays/plan.js"
import type { OverlayContext } from "./overlays/types.js"

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

/** The text a person reads off the screen: styling removed, box borders removed, wrapped rows joined. */
function readable(lines: readonly string[]): string {
  return lines
    .map((line) => stripAnsi(line).replace(/[│╭╮╰╯─]/g, " "))
    .join(" ")
    .replace(/\s+/g, " ")
}

const line = (id: string, kind: PlanLine["kind"], text: string, extra: Partial<PlanLine> = {}): PlanLine => ({ id, kind, text, requires: isRepositoryWork({ kind }) || kind === "agent_budget" ? "info" : "approval", editable: false, ...extra })

/** The plan of the recorded QA run: 15 lines, the wizard's own wording (10 of them were cut at 96 characters). */
const PLAN_LINES: PlanLine[] = [
  line("consent_mode", "consent_mode", "Consent for Infinite's tag and the Meta ad-click cookie this run adds: choose collect by default, or wait for my banner's yes. Other banners do not control them until you connect their yes/no signal.", { editable: true }),
  line("conversion_names", "conversion_names", "Conversions: signup", { editable: true }),
  line("npm_install", "npm_install", "Install the server-lane package (runs its install scripts): npm install @vercel/functions", { editable: true }),
  line("install_provider:infinite", "install_provider", "Install Infinite"),
  line(
    "server_lane",
    "server_lane",
    "Server lane (Next.js middleware): counts every page request on your server, even with ad blockers. After you merge, the one real test visit lands TWO bot-flagged page rows in your Infinite ledger (the visit itself and a server-lane probe). The no-send checks before that land none."
  ),
  line("improve_additive:posthog:proxy", "improve_additive", "PostHog: send through /ingest on your own domain, so ad blockers do not drop it. Changes your existing PostHog setup.", { ownership: "adopted" }),
  line("improve_additive:posthog:history_change", "improve_additive", "PostHog: count page changes in your single-page app. Changes your existing PostHog setup.", { ownership: "adopted" }),
  line(
    "posthog_defaults_bump_adopted:posthog",
    "posthog_defaults_bump_adopted",
    "PostHog: update your existing setup to PostHog's current recommended settings (their 2026-01-30 defaults). This changes how PostHog measures; the report marks it \"measurement changed\", never growth."
  ),
  line("remove_duplicate:ga4:G-FAKE00001", "remove_duplicate", "GA4: G-FAKE00001 is set up 2 times in your code, so page views count more than once. Keep one.", { measured: { value: "2 page views per visit", window: "dry load" } }),
  line("preview_guard_adopted:ga4", "preview_guard_adopted", "Previews stay silent for your existing GA4, PostHog and Meta tags; acme-store.com and www.acme-store.com always fire."),
  line("sensitive_pages", "sensitive_pages", "PostHog: no session replay and no autocapture on sensitive pages (/login, /account/billing)."),
  line("meta_relay", "meta_relay", "Meta server events: send your server-side conversions to Meta through Infinite, with ONE shared event id so the browser and server never count twice."),
  line("checkin", "checkin", "Infinite checks your site again 7 days after the deploy and shows you what it finds.", { requires: "info" }),
  line("agent_budget", "agent_budget", "Claude Code: 11 jobs · Opus 4.8 at xhigh effort · up to 30 turns or 10 min · your Claude plan pays (Infinite pays $0)")
]

const planPayload = (lines: PlanLine[] = PLAN_LINES): AskPayloads["plan"] => ({
  lines,
  decisions: { consentMode: null, conversionNames: ["signup"], privacyText: null, npmInstall: "npm install @vercel/functions" }
})

function planFrame(width: number, height: number, payload = planPayload(), keys = ""): string[] {
  let state = OVERLAYS.plan.init(payload)
  for (const key of keys) {
    state = OVERLAYS.plan.onKey(payload, state, key === "↓" ? { name: "down" } : { name: "char", char: key }).state
  }
  const overlay = (ctx: OverlayContext) => OVERLAYS.plan.render(payload, state, ctx)
  const snapshot = makeSnapshot({
    steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "ok" }, keys: { state: "ok" }, plan: { state: "running" } }),
    currentStep: "plan",
    pendingAsk: { askId: "a1", kind: "plan", payload }
  })
  return frame({ snapshot, overlay, width, height })
}

/** A plan line as the screen words it (its text, then the measured value in brackets). */
const shown = (planLine: PlanLine): string => (planLine.measured ? `${planLine.text} (${planLine.measured.value} · ${planLine.measured.window})` : planLine.text)

describe("F1: the plan screen shows the FULL text of every line the user approves", () => {
  for (const width of [80,]) {
    it(`${width} columns: every plan line is on screen in full, wrapped under its text, never cut`, () => {
      const lines = planFrame(width, 90)
      const text = readable(lines)
      for (const planLine of PLAN_LINES) expect(text, planLine.id).toContain(shown(planLine).replace(/\s+/g, " "))
      // Nothing in the box is cut, and the box never runs past the terminal.
      const box = lines.map(stripAnsi).filter((row) => /│\s*$/.test(row))
      expect(box.length).toBeGreaterThan(PLAN_LINES.length)
      for (const row of box) expect(row).not.toContain("…")
      for (const row of lines) expect(visibleWidth(row)).toBeLessThan(width)
      // The keys stay on screen below the lines.
      expect(text).toContain("ENTER continue")
      expect(text).toContain("ESC later")
    })
  }

  it("a short terminal scrolls whole lines: the line under the cursor is always in full, and the rest is counted", () => {
    const seen = new Set<string>()
    for (let down = 0; down < PLAN_LINES.length; down += 1) {
      const lines = planFrame(120, 36, planPayload(), "↓".repeat(down))
      expect(lines.length).toBeLessThanOrEqual(36)
      const text = readable(lines)
      // The cursor's line: full text, and the keys are still on screen.
      expect(text, PLAN_LINES[down]!.id).toContain(shown(PLAN_LINES[down]!).replace(/\s+/g, " "))
      expect(text).toMatch(/ENTER (approve|read on)/)
      for (const planLine of PLAN_LINES) if (text.includes(shown(planLine).replace(/\s+/g, " "))) seen.add(planLine.id)
      // A line is on screen in full or not at all (never half of one).
      for (const row of lines.map(stripAnsi).filter((candidate) => /│\s*$/.test(candidate))) expect(row).not.toContain("…")
    }
    // Walking the cursor through the plan puts every line on screen in full.
    expect([...seen].sort()).toEqual(PLAN_LINES.map((planLine) => planLine.id).sort())
    // What is not on screen is counted, so the user knows there is more to read.
    expect(readable(planFrame(120, 36))).toMatch(/↓ \d+ more lines? below/)
    expect(readable(planFrame(120, 36, planPayload(), "↓".repeat(PLAN_LINES.length - 1)))).toMatch(/↑ \d+ more lines? above/)
  })
})

// ---------------------------------------------------------------------------------------------------------
// Terminal round 2 (final verify round 2: F1b, F11, F13).

const PLAN_SNAPSHOT = (payload: AskPayloads["plan"]) =>
  makeSnapshot({
    steps: stepRows({ link: { state: "ok" }, agent: { state: "ok" }, before: { state: "ok" }, keys: { state: "ok" }, plan: { state: "running" } }),
    currentStep: "plan",
    pendingAsk: { askId: "a1", kind: "plan", payload }
  })

type PlanKey = "↓" | "↑" | "enter" | "space" | "e"

/** Drives the plan like `TtyUi` does: each key gets the box the screen was drawn in. Returns every screen drawn. */
function drivePlan(width: number, height: number, payload: AskPayloads["plan"], keys: readonly PlanKey[]) {
  let state: PlanState = OVERLAYS.plan.init(payload)
  let answer: unknown
  const snapshot = PLAN_SNAPSHOT(payload)
  const draw = () => frame({ snapshot, width, height, overlay: (ctx: OverlayContext) => OVERLAYS.plan.render(payload, state, ctx) })
  const frames = [draw()]
  for (const key of keys) {
    const current = state
    const ctx = overlayContext({ snapshot, width, height, styles: makeStyles(true), sanitize: makeTestSanitizer(), spinnerIndex: 0, overlay: (overlayCtx) => OVERLAYS.plan.render(payload, current, overlayCtx) })
    const outcome = OVERLAYS.plan.onKey(
      payload,
      state,
      key === "↓" ? { name: "down" } : key === "↑" ? { name: "up" } : key === "enter" ? { name: "enter" } : key === "space" ? { name: "space" } : { name: "char", char: "e" },
      ctx ?? undefined
    )
    state = outcome.state
    if ("answer" in outcome) {
      answer = outcome.answer
      break
    }
    frames.push(draw())
  }
  return { state, answer, frames }
}

const chosenPayload = (lines: PlanLine[] = PLAN_LINES): AskPayloads["plan"] => ({ ...planPayload(lines), decisions: { ...planPayload(lines).decisions, consentMode: "not_required" } })
const fullText = (planLine: PlanLine) => shown(planLine).replace(/\s+/g, " ")

describe("F11: ENTER never approves a plan line that was not on screen", () => {
  const needUser = PLAN_LINES
  const defaultAnswer = { approved: PLAN_LINES.filter(line => line.requires === "info" && isRepositoryWork(line) || ["consent_mode", "conversion_names"].includes(line.kind)).map(line => line.id), declined: [], edits: {} }

  it("120×36: the first ENTER shows the next unread lines and says how many are left; it approves only after every line was shown", () => {
    const opened = drivePlan(120, 36, chosenPayload(), [])
    const unreadAtOpen = needUser.filter((planLine) => !readable(opened.frames[0]!).includes(fullText(planLine)))
    expect(unreadAtOpen.length).toBeGreaterThan(3)
    expect(readable(opened.frames[0]!)).toContain("ENTER read on")
    expect(readable(opened.frames[0]!)).not.toContain("ENTER continue")

    const once = drivePlan(120, 36, chosenPayload(), ["enter"])
    expect(once.answer).toBeUndefined()
    // It moved to the first line that was not on screen, and that line is now on screen in full.
    expect(PLAN_LINES[once.state.cursor]!.id).toBe(unreadAtOpen[0]!.id)
    expect(readable(once.frames.at(-1)!)).toContain(fullText(unreadAtOpen[0]!))
    expect(readable(once.frames.at(-1)!)).toMatch(/(\d+ more lines? to read before you continue: ENTER shows the next, ↓ scrolls\.|That is the whole plan\. ENTER continues with it as shown\.)/)

    // ENTER again and again: it answers in the end, and by then every line was on a screen in full.
    const keys: PlanKey[] = []
    let run = opened
    while (run.answer === undefined && keys.length < 20) {
      keys.push("enter")
      run = drivePlan(120, 36, chosenPayload(), keys)
    }
    expect(keys.length).toBeGreaterThanOrEqual(2)
    const everShown = run.frames.map(readable).join(" ")
    for (const planLine of needUser) expect(everShown, planLine.id).toContain(fullText(planLine))
    expect(readable(run.frames.at(-1)!)).toContain("That is the whole plan. ENTER continues with it as shown.")
    expect(readable(run.frames.at(-1)!)).toContain("ENTER continue")
    expect(run.answer).toEqual(defaultAnswer)
  })
})

